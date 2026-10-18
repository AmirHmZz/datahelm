import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, connectionPath } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { SelectControl } from "./components/ui/select";
import {
  PrivilegeCard,
  RoleAssignment,
  type Privilege,
} from "./PrivilegeEditor";
import { ErrorBox } from "./App";

export default function AccessEditor({
  id,
  kind,
  row,
  onClose,
  onSave,
}: {
  id: string;
  kind: string;
  row: any;
  onClose: () => void;
  onSave: (body: any) => Promise<void>;
}) {
  const [name, setName] = useState(row.user || row.role || "");
  const [db, setDb] = useState(row.db);
  const [password, setPassword] = useState("");
  const [mechanism, setMechanism] = useState(row.mechanisms?.join(",") || "");
  const [roles, setRoles] = useState<{ db: string; role: string }[]>(
    row.roles || [],
  );
  const [privileges, setPrivileges] = useState<Privilege[]>(
    row.privileges || [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const databases = useQuery({
    queryKey: ["database-names", id],
    queryFn: () => api<string[]>(connectionPath(id, "database-names")),
    staleTime: 60000,
    retry: false,
  });
  return (
    <Dialog
      open
      onOpenChange={(value) => !value && onClose()}
      title={`${row.create ? "Create" : "Edit"} ${kind}`}
      description={
        kind === "user"
          ? "Assign database roles and manage authentication."
          : "Define reusable access privileges for a custom role."
      }
      wide
      className="access-dialog"
    >
      <form
        className="access-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (kind === "role" && privileges.some((p) => !p.actions.length))
              throw new Error("Choose at least one action for each privilege.");
            await onSave(
              kind === "user"
                ? {
                    db,
                    user: name,
                    password: password || null,
                    roles,
                    mechanisms: mechanism ? mechanism.split(",") : null,
                  }
                : {
                    db,
                    role: name,
                    roles,
                    privileges: privileges.map((p) => ({
                      resource: p.resource,
                      actions: p.actions,
                    })),
                  },
            );
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <div className="form-grid">
            <label>
              {kind === "user" ? "Username" : "Role name"}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!row.create}
                required
              />
            </label>
            <label>
              {kind === "user" ? "Authentication database" : "Role database"}
              <input
                value={db}
                onChange={(event) => setDb(event.target.value)}
                disabled={!row.create}
                required
              />
            </label>
            {kind === "user" && (
              <>
                <label>
                  Password
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      !row.create ? "Leave blank to preserve password" : ""
                    }
                    autoComplete="new-password"
                    required={row.create && db !== "$external"}
                  />
                </label>
                <label>
                  SCRAM mechanism
                  <SelectControl
                    label="SCRAM mechanism"
                    value={mechanism}
                    onValueChange={setMechanism}
                    disabled={db === "$external"}
                    options={[
                      { value: "", label: "Server default / preserve" },
                      { value: "SCRAM-SHA-256", label: "SCRAM-SHA-256" },
                      { value: "SCRAM-SHA-1", label: "SCRAM-SHA-1" },
                      {
                        value: "SCRAM-SHA-1,SCRAM-SHA-256",
                        label: "Both SCRAM mechanisms",
                      },
                    ]}
                  />
                </label>
              </>
            )}
          </div>
          <div className="form-section">
            <div className="flex justify-between mb-3">
              <p className="text-xs font-medium">
                {kind === "user" ? "Assigned roles" : "Inherited roles"}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setRoles((roles) => [...roles, { db: "admin", role: "read" }])
                }
              >
                <Plus size={12} />
                Add role
              </Button>
            </div>
            {roles.map((role, i) => (
              <RoleAssignment
                key={i}
                id={id}
                role={role}
                databases={databases.data || []}
                onChange={(key, value) =>
                  setRoles((roles) =>
                    roles.map((role, n) =>
                      n === i ? { ...role, [key]: value } : role,
                    ),
                  )
                }
                onRemove={() =>
                  setRoles((roles) => roles.filter((_, n) => n !== i))
                }
              />
            ))}
            {!roles.length && (
              <p className="text-xs text-muted-foreground">
                No roles assigned.
              </p>
            )}
          </div>
          {kind === "role" && (
            <div className="form-section">
              <div className="flex justify-between mb-3">
                <p className="text-xs font-medium">Resource privileges</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setPrivileges((privileges) => [
                      ...privileges,
                      { resource: { db, collection: "" }, actions: ["find"] },
                    ])
                  }
                >
                  <Plus size={12} />
                  Add privilege
                </Button>
              </div>
              {privileges.map((privilege, i) => (
                <PrivilegeCard
                  key={i}
                  id={id}
                  privilege={privilege}
                  databases={databases.data || []}
                  roleDb={db}
                  onChange={(value) =>
                    setPrivileges((privileges) =>
                      privileges.map((p, n) => (n === i ? value : p)),
                    )
                  }
                  onRemove={() =>
                    setPrivileges((privileges) =>
                      privileges.filter((_, n) => n !== i),
                    )
                  }
                />
              ))}
            </div>
          )}
          <ErrorBox error={error || databases.error} />
        </div>
        <div className="form-footer dialog-footer">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : `Save ${kind}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
