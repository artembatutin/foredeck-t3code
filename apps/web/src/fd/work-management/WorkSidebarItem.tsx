import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useWorkSupported } from "./state";

/** The sidebar's Work entry, shown once any environment advertises Work. */
export function WorkSidebarItem() {
  const supported = useWorkSupported();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!supported) return null;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Work"
              size="icon"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate({ to: "/work" });
              }}
            >
              <ListChecksIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Work</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
