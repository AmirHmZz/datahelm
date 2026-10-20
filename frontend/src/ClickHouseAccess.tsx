import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  chApi,
  useCH,
  inheritedRoles,
  passwordError,
  type CH,
} from "./clickhouse-api";
import { Grid, Panel, Result } from "./ClickHouseUI";
import { Button } from "./components/ui/button";
import { SelectControl } from "./components/ui/select";
import { Dialog } from "./components/ui/dialog";
import { ErrorBox } from "./App";

type Target = CH<"Target">;
type Action = { path: string; method: string; body: unknown; message: string };
type Perform = (action: Action) => Promise<boolean>;
export default function ClickHouseAccess({
  id,
  capabilities,
  notify,
}: {
  id: string;
  capabilities?: CH<"Capabilities">;
  notify: (message: string) => void;
}) {
  const cache = useQueryClient();
  const users = useCH<CH<"UserRow">[]>(id, "users");
  const roles = useCH<CH<"RoleRow">[]>(id, "roles");
  const grants = useCH<CH<"GrantRow">[]>(id, "grants");
  const roleGrants = useCH<CH<"RoleGrantRow">[]>(id, "role-grants");
  const privileges = useCH<CH<"PrivilegeRow">[]>(id, "privileges");
  const [selected, setSelected] = useState<Target>();
  const [create, setCreate] = useState<"user" | "role">();
  const [confirm, setConfirm] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const perform: Perform = async ({ path, method, body, message }) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await chApi(id, path, method, body);
      notify(message);
      return true;
    } catch (e) {
      setError(
        `${(e as Error).message}. Each action is independent; earlier successful actions remain applied. Refresh actual server state before retrying.`,
      );
      return false;
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ["clickhouse", id] });
      void cache.invalidateQueries({ queryKey: ["capabilities", id] });
    }
  };
  const user =
    selected?.kind === "user"
      ? users.data?.find((u) => u.name === selected.name)
      : undefined;
  const role =
    selected?.kind === "role"
      ? roles.data?.find((r) => r.name === selected.name)
      : undefined;
  const readonly = user?.readonly ?? role?.readonly ?? true;
  const direct = (grants.data || []).filter((g) =>
    selected?.kind === "user"
      ? g.user_name === selected.name
      : g.role_name === selected?.name,
  );
  const reachable = selected
    ? inheritedRoles(selected, roleGrants.data || [])
    : new Set<string>();
  const inherited = (grants.data || []).filter(
    (g) => g.role_name && reachable.has(g.role_name),
  );
  const assignments = (roleGrants.data || []).filter((g) =>
    selected?.kind === "user"
      ? g.user_name === selected.name
      : g.role_name === selected?.name,
  );
  return (
    <>
      <ErrorBox error={error} />
      <Panel
        title="Users"
        action={
          <Button
            size="sm"
            disabled={busy || !capabilities?.features.create_user?.available}
            onClick={() => {
              setError("");
              setCreate("user");
            }}
          >
            Create user
          </Button>
        }
      >
        <Result query={users}>
          {(rows) => (
            <Grid
              rows={rows}
              columns={[
                {
                  label: "User",
                  render: (u) => (
                    <button
                      className="text-primary"
                      onClick={() => {
                        setError("");
                        setSelected({ kind: "user", name: u.name });
                      }}
                    >
                      {u.name}
                    </button>
                  ),
                },
                {
                  label: "Authentication",
                  render: (u) => u.auth_type.join(", "),
                },
                {
                  label: "Access storage",
                  render: (u) =>
                    `${u.storage}${u.readonly ? " · read-only" : ""}`,
                },
                {
                  label: "Allowed networks",
                  render: (u) =>
                    [
                      ...u.host_ip,
                      ...u.host_names,
                      ...u.host_names_regexp,
                      ...u.host_names_like,
                    ].join(", ") || "None",
                },
              ]}
            />
          )}
        </Result>
      </Panel>
      <Panel
        title="Roles"
        action={
          <Button
            size="sm"
            disabled={busy || !capabilities?.features.create_role?.available}
            onClick={() => {
              setError("");
              setCreate("role");
            }}
          >
            Create role
          </Button>
        }
      >
        <Result query={roles}>
          {(rows) => (
            <Grid
              rows={rows}
              columns={[
                {
                  label: "Role",
                  render: (r) => (
                    <button
                      className="text-primary"
                      onClick={() => {
                        setError("");
                        setSelected({ kind: "role", name: r.name });
                      }}
                    >
                      {r.name}
                    </button>
                  ),
                },
                {
                  label: "Access storage",
                  render: (r) =>
                    `${r.storage}${r.readonly ? " · read-only" : ""}`,
                },
              ]}
            />
          )}
        </Result>
      </Panel>
      <ErrorBox error={grants.error || roleGrants.error || privileges.error} />
      {selected && (
        <Panel
          title={`${selected.kind === "user" ? "User" : "Role"} · ${selected.name}`}
          action={
            <Button
              size="sm"
              variant="destructive"
              disabled={
                busy ||
                readonly ||
                !capabilities?.features[
                  selected.kind === "user" ? "delete_user" : "delete_role"
                ]?.available
              }
              onClick={() =>
                setConfirm({
                  path: selected.kind === "user" ? "users" : "roles",
                  method: "DELETE",
                  body: { name: selected.name },
                  message: `${selected.kind} deleted`,
                })
              }
            >
              Delete {selected.kind}
            </Button>
          }
        >
          <div className="p-5">
            {readonly && (
              <p className="notice">
                This access entity is read-only in its configured storage.
              </p>
            )}
            <AccessActions
              key={`${selected.kind}:${selected.name}`}
              target={selected}
              user={user}
              roles={roles.data || []}
              privileges={privileges.data || []}
              disabled={busy || readonly}
              canUpdateUser={!!capabilities?.features.update_user?.available}
              perform={perform}
            />
            <h3 className="text-sm font-medium mt-6 mb-3">
              Direct role assignments
            </h3>
            <Grid
              rows={assignments}
              columns={[
                { label: "Role", render: (r) => r.granted_role_name },
                {
                  label: "Default / admin option",
                  render: (r) =>
                    `${r.granted_role_is_default ? "Default" : "Not default"} / ${r.with_admin_option ? "Admin option" : "No admin option"}`,
                },
                {
                  label: "Action",
                  render: (r) => (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || readonly}
                      onClick={() =>
                        setConfirm({
                          path: "role-grants",
                          method: "DELETE",
                          body: {
                            target: selected,
                            role: r.granted_role_name,
                            admin_option: false,
                          },
                          message: "Role assignment revoked",
                        })
                      }
                    >
                      Revoke role
                    </Button>
                  ),
                },
              ]}
            />
            <div className="flex gap-2 mt-3">
              {assignments
                .filter((r) => r.with_admin_option)
                .map((r) => (
                  <Button
                    key={r.granted_role_name}
                    size="sm"
                    variant="outline"
                    disabled={busy || readonly}
                    onClick={() =>
                      setConfirm({
                        path: "role-grants",
                        method: "DELETE",
                        body: {
                          target: selected,
                          role: r.granted_role_name,
                          admin_option: true,
                        },
                        message: "Role admin option revoked",
                      })
                    }
                  >
                    Revoke admin option · {r.granted_role_name}
                  </Button>
                ))}
            </div>
            <h3 className="text-sm font-medium mt-6 mb-3">
              Direct privileges and partial revokes
            </h3>
            <GrantGrid
              rows={direct}
              revoke={(g, optionOnly = false) =>
                setConfirm({
                  path: "grants",
                  method: "DELETE",
                  body: {
                    target: selected,
                    privilege: g.access_type,
                    database: g.database ?? "*",
                    table: g.table ?? "*",
                    column: g.column,
                    grant_option: optionOnly,
                  },
                  message: optionOnly
                    ? "Grant option revoked"
                    : "Privilege revoked",
                })
              }
              disabled={busy || readonly}
            />
            <h3 className="text-sm font-medium mt-6 mb-3">
              Inherited role privileges
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Reachable role grants; active/default roles and partial revokes
              can narrow effective session access. Edit the source role to
              change inherited grants.
            </p>
            <GrantGrid rows={inherited} disabled />
          </div>
        </Panel>
      )}
      {create && (
        <CreateEntity
          kind={create}
          busy={busy}
          perform={perform}
          onClose={() => !busy && setCreate(undefined)}
          onCreated={(name) => {
            setSelected({ kind: create, name });
            setCreate(undefined);
          }}
          error={error}
        />
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => !busy && !open && setConfirm(undefined)}
        title="Confirm access change"
        description={`Apply this change to ${selected?.name || "the selected entity"} on the connected server? It may affect existing access or the account used by this saved connection.`}
      >
        <ErrorBox error={error} />
        <div className="form-footer">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setConfirm(undefined)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (confirm && (await perform(confirm))) setConfirm(undefined);
            }}
          >
            Confirm change
          </Button>
        </div>
      </Dialog>
    </>
  );
}
function GrantGrid({
  rows,
  disabled,
  revoke,
}: {
  rows: CH<"GrantRow">[];
  disabled: boolean;
  revoke?: (g: CH<"GrantRow">, optionOnly?: boolean) => void;
}) {
  return (
    <Grid
      rows={rows}
      columns={[
        {
          label: "Privilege / source",
          render: (g) => `${g.access_type} · ${g.role_name || g.user_name}`,
        },
        {
          label: "Scope",
          render: (g) =>
            `${g.database ?? "*"}.${g.table ?? "*"}${g.column ? ` (${g.column})` : ""}`,
        },
        {
          label: "Type",
          render: (g) =>
            g.is_partial_revoke
              ? "Partial revoke (read-only here)"
              : g.grant_option
                ? "Grant with grant option"
                : "Grant",
        },
        ...(revoke
          ? [
              {
                label: "Action",
                render: (g: CH<"GrantRow">) => (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || !!g.is_partial_revoke}
                      onClick={() => revoke(g)}
                    >
                      Revoke privilege
                    </Button>
                    {!!g.grant_option && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled || !!g.is_partial_revoke}
                        onClick={() => revoke(g, true)}
                      >
                        Revoke grant option
                      </Button>
                    )}
                  </div>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
function CreateEntity({
  kind,
  busy,
  perform,
  onClose,
  onCreated,
  error,
}: {
  kind: "user" | "role";
  busy: boolean;
  perform: Perform;
  onClose: () => void;
  onCreated: (name: string) => void;
  error: string;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [validation, setValidation] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Create ClickHouse ${kind}`}
      description={
        kind === "user"
          ? "New users use bcrypt passwords and HOST ANY (all networks). Adjust networks and assign roles after creation."
          : "Create a SQL-managed role, then assign privileges and inherited roles."
      }
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const error = kind === "user" ? passwordError(password) : "";
          setValidation(error);
          if (error) return;
          if (
            await perform({
              path: kind === "user" ? "users" : "roles",
              method: "POST",
              body: kind === "user" ? { name, password } : { name },
              message: `${kind} created`,
            })
          )
            onCreated(name);
        }}
      >
        <label>
          {kind === "user" ? "Username" : "Role name"}
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </label>
        {kind === "user" && (
          <label className="mt-4">
            Password
            <input
              required
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="text-xs">1–72 UTF-8 bytes · bcrypt_password</span>
          </label>
        )}
        <ErrorBox error={validation || error} />
        <div className="form-footer">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Create {kind}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function ActionForm({
  title,
  disabled,
  submit,
  children,
  destructive = false,
}: {
  title: string;
  disabled: boolean;
  submit: () => void | Promise<void>;
  children: ReactNode;
  destructive?: boolean;
}) {
  return (
    <form
      className="card p-4 mb-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="font-medium text-sm mb-4">{title}</h3>
      <fieldset disabled={disabled}>
        {children}
        <Button
          className="mt-4"
          type="submit"
          size="sm"
          variant={destructive ? "destructive" : "outline"}
          disabled={disabled}
        >
          {title}
        </Button>
      </fieldset>
    </form>
  );
}
function AccessActions({
  target,
  user,
  roles,
  privileges,
  disabled,
  canUpdateUser,
  perform,
}: {
  target: Target;
  user?: CH<"UserRow">;
  roles: CH<"RoleRow">[];
  privileges: CH<"PrivilegeRow">[];
  disabled: boolean;
  canUpdateUser: boolean;
  perform: Perform;
}) {
  const [password, setPassword] = useState("");
  const [validation, setValidation] = useState("");
  const [role, setRole] = useState("");
  const [admin, setAdmin] = useState(false);
  const [privilege, setPrivilege] = useState("SELECT");
  const [database, setDatabase] = useState("*");
  const [table, setTable] = useState("*");
  const [column, setColumn] = useState("");
  const [grantOption, setGrantOption] = useState(false);
  const [defaultMode, setDefaultMode] = useState("none");
  const [defaultList, setDefaultList] = useState("");
  const [replaceDefaults, setReplaceDefaults] = useState(false);
  const [networkMode, setNetworkMode] = useState("ip");
  const [addresses, setAddresses] = useState("");
  const [replaceNetworks, setReplaceNetworks] = useState(false);
  const authEditable =
    user &&
    user.auth_type.length === 1 &&
    [
      "bcrypt_password",
      "sha256_password",
      "double_sha1_password",
      "plaintext_password",
    ].includes(user.auth_type[0]);
  return (
    <>
      <ErrorBox error={validation} />
      <div className="grid lg:grid-cols-2 gap-4">
        <ActionForm
          title="Grant privilege"
          disabled={disabled || !privileges.length}
          submit={async () => {
            await perform({
              path: "grants",
              method: "POST",
              body: {
                target,
                privilege,
                database,
                table,
                column: column || null,
                grant_option: grantOption,
              },
              message: "Privilege granted",
            });
          }}
        >
          <label>
            Privilege
            <SelectControl
              label="Privilege"
              value={privilege}
              onValueChange={setPrivilege}
              options={privileges.map((p) => ({
                value: p.privilege,
                label: `${p.privilege} · ${p.level}`,
              }))}
            />
          </label>
          <div className="form-grid mt-3">
            <label>
              Database (* for all)
              <input
                required
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
              />
            </label>
            <label>
              Table (* for all)
              <input
                required
                value={table}
                onChange={(e) => setTable(e.target.value)}
              />
            </label>
          </div>
          <label className="mt-3">
            Column (optional)
            <input value={column} onChange={(e) => setColumn(e.target.value)} />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={grantOption}
              onChange={(e) => setGrantOption(e.target.checked)}
            />
            WITH GRANT OPTION
          </label>
        </ActionForm>
        <ActionForm
          title="Assign role"
          disabled={disabled || !roles.length}
          submit={async () => {
            await perform({
              path: "role-grants",
              method: "POST",
              body: { target, role, admin_option: admin },
              message: "Role assigned",
            });
          }}
        >
          <label>
            Role
            <SelectControl
              label="Assign role"
              value={role}
              onValueChange={setRole}
              options={roles
                .filter((r) => target.kind === "user" || r.name !== target.name)
                .map((r) => ({ value: r.name, label: r.name }))}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={admin}
              onChange={(e) => setAdmin(e.target.checked)}
            />
            WITH ADMIN OPTION
          </label>
        </ActionForm>
        {user && (
          <>
            <ActionForm
              title="Reset password"
              disabled={disabled || !canUpdateUser || !authEditable}
              submit={async () => {
                const error = passwordError(password);
                setValidation(error);
                if (
                  !error &&
                  (await perform({
                    path: "users",
                    method: "PATCH",
                    body: { name: user.name, password },
                    message:
                      "Password changed; update any saved connection credentials separately",
                  }))
                )
                  setPassword("");
              }}
            >
              <label>
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <p className="text-xs mt-3">
                1–72 UTF-8 bytes. External or multiple-method authentication is
                read-only. Saved connection credentials are updated separately.
              </p>
            </ActionForm>
            <ActionForm
              title="Replace default roles"
              disabled={disabled || !canUpdateUser}
              submit={async () => {
                if (!replaceDefaults) return;
                if (
                  await perform({
                    path: "default-roles",
                    method: "PUT",
                    body: {
                      user: user.name,
                      mode: defaultMode,
                      roles:
                        defaultMode === "list"
                          ? defaultList
                              .split(",")
                              .map((r) => r.trim())
                              .filter(Boolean)
                          : [],
                    },
                    message: "Default roles updated",
                  })
                )
                  setReplaceDefaults(false);
              }}
            >
              <p className="text-xs mb-3">
                Current:{" "}
                {user.default_roles_all
                  ? "ALL"
                  : user.default_roles_list.join(", ") || "NONE"}
                {user.default_roles_except.length
                  ? ` EXCEPT ${user.default_roles_except.join(", ")}`
                  : ""}
              </p>
              <label>
                Default role mode
                <SelectControl
                  label="Default role mode"
                  value={defaultMode}
                  onValueChange={setDefaultMode}
                  options={[
                    { value: "none", label: "NONE" },
                    { value: "all", label: "ALL" },
                    { value: "list", label: "Specific roles" },
                  ]}
                />
              </label>
              {defaultMode === "list" && (
                <label className="mt-3">
                  Role names (comma separated)
                  <input
                    required
                    value={defaultList}
                    onChange={(e) => setDefaultList(e.target.value)}
                  />
                </label>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  required
                  checked={replaceDefaults}
                  onChange={(e) => setReplaceDefaults(e.target.checked)}
                />
                Replace the existing default-role selection
              </label>
            </ActionForm>
            <ActionForm
              title="Replace allowed networks"
              disabled={disabled || !canUpdateUser}
              submit={async () => {
                if (!replaceNetworks) return;
                if (
                  await perform({
                    path: "networks",
                    method: "PUT",
                    body: {
                      user: user.name,
                      mode: networkMode,
                      addresses:
                        networkMode === "ip"
                          ? addresses.split(/[\s,]+/).filter(Boolean)
                          : [],
                    },
                    message: "Allowed networks updated",
                  })
                )
                  setReplaceNetworks(false);
              }}
            >
              <p className="text-xs mb-3">
                Current IPs: {user.host_ip.join(", ") || "None"}. Host
                names/patterns:{" "}
                {[
                  ...user.host_names,
                  ...user.host_names_regexp,
                  ...user.host_names_like,
                ].join(", ") || "None"}
                . These remain unchanged until explicitly replaced.
              </p>
              <label>
                Network restriction
                <SelectControl
                  label="Network restriction"
                  value={networkMode}
                  onValueChange={setNetworkMode}
                  options={[
                    { value: "ip", label: "IP / CIDR addresses" },
                    { value: "local", label: "LOCAL" },
                    { value: "any", label: "ANY · all networks" },
                  ]}
                />
              </label>
              {networkMode === "ip" && (
                <label className="mt-3">
                  Allowed addresses
                  <textarea
                    required
                    value={addresses}
                    onChange={(e) => setAddresses(e.target.value)}
                    placeholder="10.0.0.0/8, 2001:db8::/32"
                  />
                </label>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  required
                  checked={replaceNetworks}
                  onChange={(e) => setReplaceNetworks(e.target.checked)}
                />
                Replace all current network restrictions, including hostname
                patterns
              </label>
            </ActionForm>
          </>
        )}
      </div>
    </>
  );
}
