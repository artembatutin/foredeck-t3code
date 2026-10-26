import { useNavigate } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useFactorySupported } from "./hooks";

/** The sidebar's Factory entry, shown once any environment advertises Factory. */
export function FactorySidebarItem() {
  const supported = useFactorySupported();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!supported) return null;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Factory"
              size="icon"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate({ to: "/factory" });
              }}
            >
              <FactoryIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Factory</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
