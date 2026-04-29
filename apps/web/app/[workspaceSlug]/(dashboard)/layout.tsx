"use client";

import { DashboardLayout } from "@multica/views/layout";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { SearchCommand, SearchTrigger } from "@multica/views/search";
import { StarterContentPrompt } from "@multica/views/onboarding";
import { FloatingTimer } from "@multica/views/time-tracking/floating-timer";
import { IdleDetector } from "@multica/views/time-tracking/idle-detector";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardLayout
      loadingIndicator={<MulticaIcon className="size-6" />}
      searchSlot={<SearchTrigger />}
      extra={
        <>
          <SearchCommand />
          <StarterContentPrompt />
          <FloatingTimer />
          <IdleDetector />
        </>
      }
    >
      {children}
    </DashboardLayout>
  );
}
