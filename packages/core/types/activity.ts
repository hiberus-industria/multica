import type { Reaction } from "./comment";
import type { Attachment } from "./attachment";

export interface AssigneeFrequencyEntry {
  assignee_type: string;
  assignee_id: string;
  frequency: number;
}

export interface TimelineEntry {
  type: "activity" | "comment" | "time_entry";
  id: string;
  actor_type: string;
  actor_id: string;
  // Actor name/avatar (populated for agent entries and comments)
  actor_name?: string;
  actor_avatar_url?: string | null;
  created_at: string;
  // Activity fields
  action?: string;
  details?: Record<string, unknown>;
  // Comment fields
  content?: string;
  parent_id?: string | null;
  updated_at?: string;
  comment_type?: string;
  reactions?: Reaction[];
  attachments?: Attachment[];
  // Time entry fields (when type === "time_entry")
  duration_minutes?: number;
  activity_name?: string | null;
  time_entry_comment?: string | null;
  agent_task_id?: string | null;
}
