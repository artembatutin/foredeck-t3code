import type { useRepositoryWorkspace } from "./useRepositoryWorkspace";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../components/ui/menu";

export function RepositorySelector({
  workspace,
}: {
  workspace: ReturnType<typeof useRepositoryWorkspace>;
}) {
  if (!workspace.isMultiRepository) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="xs" variant="secondary" />}
        aria-label="Select repository"
      >
        {workspace.selected?.name ?? "Select repository"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={workspace.selected?.id ?? ""}
          onValueChange={workspace.selectRepository}
        >
          {workspace.repositories.map((repository) => (
            <DropdownMenuRadioItem key={repository.id} value={repository.id} closeOnClick>
              <div>
                <div>{repository.name}</div>
                <div className="text-xs text-muted-foreground">{repository.rootPath}</div>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
