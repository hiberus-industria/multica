package main

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var timeCmd = &cobra.Command{
	Use:   "time",
	Short: "Time tracking commands",
}

var timeLogCmd = &cobra.Command{
	Use:   "log <issue-id>",
	Short: "Log time on an issue",
	Args:  exactArgs(1),
	RunE:  runTimeLog,
}

func init() {
	timeLogCmd.Flags().String("duration", "", "Duration (e.g. 2h, 30m, 1:30, 1h30m)")
	timeLogCmd.Flags().String("comment", "", "Description of work done")
	timeLogCmd.Flags().String("activity", "", "Redmine activity name")
	_ = timeLogCmd.MarkFlagRequired("duration")

	timeCmd.AddCommand(timeLogCmd)
	rootCmd.AddCommand(timeCmd)
}

func parseDurationToMinutes(s string) (int, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 0, fmt.Errorf("empty duration")
	}

	// "1:30" format
	if m := regexp.MustCompile(`^(\d+):(\d{1,2})$`).FindStringSubmatch(s); m != nil {
		h, _ := strconv.Atoi(m[1])
		min, _ := strconv.Atoi(m[2])
		return h*60 + min, nil
	}

	// "1h30m" or "1h 30m" or "1.5h"
	if m := regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*h\s*(?:(\d+)\s*m)?$`).FindStringSubmatch(s); m != nil {
		hf, _ := strconv.ParseFloat(m[1], 64)
		mins := int(hf * 60)
		if m[2] != "" {
			extra, _ := strconv.Atoi(m[2])
			mins += extra
		}
		return mins, nil
	}

	// "30m"
	if m := regexp.MustCompile(`^(\d+)\s*m$`).FindStringSubmatch(s); m != nil {
		min, _ := strconv.Atoi(m[1])
		return min, nil
	}

	// plain number → minutes
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n, nil
	}

	return 0, fmt.Errorf("unrecognized duration format: %q (use 2h, 30m, 1:30, or 1h30m)", s)
}

func runTimeLog(cmd *cobra.Command, args []string) error {
	issueID := args[0]
	durationStr, _ := cmd.Flags().GetString("duration")
	comment, _ := cmd.Flags().GetString("comment")
	activity, _ := cmd.Flags().GetString("activity")

	minutes, err := parseDurationToMinutes(durationStr)
	if err != nil {
		return err
	}
	if minutes < 1 {
		return fmt.Errorf("duration must be at least 1 minute")
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	taskID := os.Getenv("MULTICA_TASK_ID")

	var body map[string]interface{}
	var endpoint string

	if taskID != "" {
		// Agent context: use agent-task endpoint
		endpoint = fmt.Sprintf("/api/daemon/tasks/%s/time-entries", taskID)
		body = map[string]interface{}{
			"issue_id":         issueID,
			"duration_minutes": minutes,
		}
	} else {
		// User context: use issue endpoint
		endpoint = fmt.Sprintf("/api/workspaces/%s/issues/%s/time-entries",
			client.WorkspaceID, issueID)
		body = map[string]interface{}{
			"duration_minutes": minutes,
		}
	}

	if comment != "" {
		body["comment"] = comment
	}
	if activity != "" {
		body["activity_name"] = activity
	}

	var resp map[string]interface{}
	if err := client.PostJSON(cmd.Context(), endpoint, body, &resp); err != nil {
		return fmt.Errorf("failed to log time: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, resp)
	}

	durationFmt := durationStr
	if minutes < 60 {
		durationFmt = fmt.Sprintf("%dm", minutes)
	} else {
		h := minutes / 60
		m := minutes % 60
		if m > 0 {
			durationFmt = fmt.Sprintf("%dh %dm", h, m)
		} else {
			durationFmt = fmt.Sprintf("%dh", h)
		}
	}
	fmt.Printf("Logged %s on issue %s\n", durationFmt, issueID)
	return nil
}
