import { useId, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { ChevronDown, Search, X } from "lucide-react";
import { api, connectionPath } from "./api";
import { Button } from "./components/ui/button";
import { SelectControl, type SelectOption } from "./components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import { ErrorBox } from "./App";

export type Privilege = {
  resource: {
    db?: string;
    collection?: string;
    cluster?: boolean;
    anyResource?: boolean;
  };
  actions: string[];
};
export function resourceNames(
  names: string[] = [],
  ...existing: (string | undefined)[]
): SelectOption[] {
  return [
    ...new Set(
      [...names, ...existing].filter((name): name is string => !!name),
    ),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: value }));
}
const roleOptions = (id: string, db: string) => ({
  queryKey: ["role-options", id, db],
  queryFn: () => api(connectionPath(id, `roles?db=${encodeURIComponent(db)}`)),
  staleTime: 60000,
  retry: false,
});

export function availableActions(
  roles: any[],
  scope: "database" | "cluster" | "any",
): string[] {
  return [
    ...new Set<string>(
      roles
        .flatMap((role) => [
          ...(role.privileges || []),
          ...(role.inheritedPrivileges || []),
        ])
        .filter(
          (privilege) =>
            scope === "any" ||
            (scope === "cluster"
              ? privilege.resource?.cluster
              : typeof privilege.resource?.db === "string" ||
                typeof privilege.resource?.system_buckets === "string"),
        )
        .flatMap((privilege) => privilege.actions || []),
    ),
  ].sort();
}

export function ActionPicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string[];
  options: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const id = useId();
  const choices = [...new Set([...options, ...value])].sort();
  const visible = choices.filter((action) =>
    action.toLowerCase().includes(search.toLowerCase()),
  );
  const toggle = (action: string) =>
    onChange(
      value.includes(action)
        ? value.filter((v) => v !== action)
        : [...value, action],
    );
  return (
    <div className="action-picker">
      <span id={id} className="field-label">
        Actions
      </span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="select-trigger"
            aria-label="Select actions"
            aria-describedby={id}
            disabled={disabled}
          >
            <span>
              {value.length
                ? `${value.length} ${value.length === 1 ? "action" : "actions"} selected`
                : "Select actions…"}
            </span>
            <ChevronDown size={15} className="select-chevron" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="actions-menu"
          aria-label="Choose privilege actions"
        >
          <div className="action-search">
            <Search size={14} />
            <input
              aria-label="Search actions"
              placeholder="Search actions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div
            className="actions-list"
            role="group"
            aria-label="Available actions"
          >
            {visible.map((action) => (
              <label key={action} className="action-option">
                <input
                  type="checkbox"
                  checked={value.includes(action)}
                  onChange={() => toggle(action)}
                />
                <span className="mono">{action}</span>
              </label>
            ))}
            {!visible.length && (
              <p className="p-4 text-xs text-muted-foreground">
                No matching actions.
              </p>
            )}
          </div>
          <div className="actions-footer">
            <span>{value.length} selected</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Done
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {!!value.length && (
        <div className="action-chips" aria-label="Selected actions">
          {value.map((action) => (
            <span key={action} className="action-chip mono">
              {action}
              <button
                type="button"
                aria-label={`Remove ${action} action`}
                onClick={() => toggle(action)}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function PrivilegeCard({
  id,
  privilege,
  databases,
  roleDb,
  onChange,
  onRemove,
}: {
  id: string;
  privilege: Privilege;
  databases: string[];
  roleDb: string;
  onChange: (privilege: Privilege) => void;
  onRemove: () => void;
}) {
  const { resource, actions } = privilege;
  const scope = resource.cluster
    ? "cluster"
    : resource.anyResource
      ? "any"
      : "database";
  const roles = useQuery(
    roleOptions(id, scope === "database" ? roleDb : "admin"),
  );
  // Wildcard database resources may target a named collection across databases.
  const collectionDbs =
    scope !== "database"
      ? []
      : resource.db
        ? [resource.db]
        : [...new Set([...databases, roleDb].filter(Boolean))];
  const collections = useQueries({
    queries: collectionDbs.map((db) => ({
      queryKey: ["collection-names", id, db],
      queryFn: () =>
        api<string[]>(
          connectionPath(id, `collection-names?db=${encodeURIComponent(db)}`),
        ),
      staleTime: 60000,
      retry: false,
    })),
  });
  const names = collections.flatMap((query) => query.data || []);
  const actionChoices = availableActions(roles.data?.roles || [], scope);
  const collectionError = collections.find((query) => query.error)?.error;
  return (
    <div className="card privilege-card">
      <div className="flex gap-3 items-end">
        <label className="flex-1 min-w-0">
          Resource scope
          <SelectControl
            label="Resource scope"
            value={scope}
            options={[
              { value: "database", label: "Database / collection" },
              { value: "cluster", label: "Cluster" },
              { value: "any", label: "All resources" },
            ]}
            onValueChange={(value) => {
              const nextScope = value as typeof scope;
              const compatible = availableActions(
                roles.data?.roles || [],
                nextScope,
              );
              onChange({
                resource:
                  nextScope === "cluster"
                    ? { cluster: true }
                    : nextScope === "any"
                      ? { anyResource: true }
                      : { db: roleDb, collection: "" },
                actions: roles.data
                  ? actions.filter((a) => compatible.includes(a))
                  : actions,
              });
            }}
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove privilege"
          onClick={onRemove}
        >
          <X size={14} />
        </Button>
      </div>
      {scope === "database" && (
        <div className="form-grid mt-3">
          <label>
            Database
            <SelectControl
              label="Database"
              value={resource.db || ""}
              options={[
                { value: "", label: "All databases" },
                ...resourceNames(databases, roleDb, resource.db),
              ]}
              onValueChange={(db) =>
                onChange({ ...privilege, resource: { db, collection: "" } })
              }
            />
          </label>
          <label>
            Collection
            <SelectControl
              label="Collection"
              value={resource.collection || ""}
              options={[
                { value: "", label: "All collections" },
                ...resourceNames(names, resource.collection),
              ]}
              disabled={collections.some((query) => query.isPending)}
              onValueChange={(collection) =>
                onChange({
                  ...privilege,
                  resource: { ...resource, collection },
                })
              }
            />
          </label>
        </div>
      )}
      <ErrorBox error={collectionError} />
      <div className="mt-3">
        <ActionPicker
          value={actions}
          options={actionChoices}
          onChange={(actions) => onChange({ ...privilege, actions })}
          disabled={roles.isPending}
        />
      </div>
      <ErrorBox error={roles.error} />
    </div>
  );
}

export function RoleAssignment({
  id,
  role,
  databases,
  onChange,
  onRemove,
}: {
  id: string;
  role: { db: string; role: string };
  databases: string[];
  onChange: (key: string, value: string) => void;
  onRemove: () => void;
}) {
  const roles = useQuery(roleOptions(id, role.db));
  return (
    <div className="mb-3">
      <div className="flex items-end gap-2">
        <label className="flex-1 min-w-0">
          Database
          <input
            value={role.db}
            placeholder={databases[0] || "admin"}
            onChange={(event) => onChange("db", event.target.value)}
            required
          />
        </label>
        <label className="flex-1 min-w-0">
          Role name
          <SelectControl
            label="Role name"
            value={role.role}
            options={resourceNames(
              (roles.data?.roles || []).map((r: any) => r.role),
              role.role,
            )}
            onValueChange={(value) => onChange("role", value)}
            disabled={roles.isPending}
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove role"
          onClick={onRemove}
        >
          <X size={14} />
        </Button>
      </div>
      <ErrorBox error={roles.error} />
    </div>
  );
}
