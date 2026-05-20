"use client";

import { useT } from "../../i18n";
import { RedmineIntegrationCard } from "./redmine-integration-card";

// GitHub now lives in its own Settings tab (see github-tab.tsx). Until other
// third-party integrations land, this tab is intentionally an empty state —
// it stays in the IA so deep links and muscle memory don't break.
export function IntegrationsTab() {
  const { t } = useT("settings");
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">
          {t(($) => $.integrations.section_title)}
        </h2>

        <RedmineIntegrationCard />
      </section>
    </div>
  );
}
