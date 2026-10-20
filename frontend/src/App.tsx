import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Database,
  Users,
  ListFilter,
  Network,
  Gauge,
  Plus,
  ChevronRight,
  Settings2,
  LogOut,
  Menu,
  RefreshCw,
  Trash2,
  ShieldCheck,
  Server,
  ArrowUpRight,
  Loader2,
  KeyRound,
} from "lucide-react";
import {
  api,
  setCsrf,
  type Session,
  type Connection,
  connectionPath,
} from "./api";
import { Button } from "./components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./components/ui/breadcrumb";
import { Dialog } from "./components/ui/dialog";
import { SelectControl } from "./components/ui/select";
import { version } from "../package.json";
import ConnectionEditor from "./ConnectionEditor";
import PasswordForm from "./PasswordForm";
import {
  Overview,
  Catalog,
  Operations,
  SlowQueries,
  Topology,
  Access,
} from "./Views";

const ClickHouseViews = lazy(() => import("./ClickHouseViews"));

const engineLabel = (c?: Connection) =>
  c?.config.engine === "clickhouse" ? "ClickHouse" : "MongoDB";
const endpointLabel = (c: Connection) =>
  c.config.engine === "clickhouse"
    ? c.config.clickhouse?.endpoint
    : c.config.mode === "uri"
      ? "MongoDB URI"
      : c.config.hosts;

const pages = [
  ["overview", "Overview", Gauge],
  ["databases", "Databases", Database],
  ["access", "Users & roles", Users],
  ["operations", "Operations", Activity],
  ["queries", "Slow queries", ListFilter],
  ["topology", "Topology", Network],
] as const;
const themeOptions = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];
export function Brand() {
  return (
    <div className="brand">
      <img
        className="brand-logo brand-logo-dark"
        src="/graphics/logos/datahelm-dark.svg"
        alt="DataHelm."
        width="1259"
        height="312"
      />
      <img
        className="brand-logo brand-logo-light"
        src="/graphics/logos/datahelm-light.svg"
        alt="DataHelm."
        width="684"
        height="178"
      />
    </div>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Database size={24} />
      </span>
      <h3 className="text-foreground font-medium">{title}</h3>
      <p className="text-xs max-w-md leading-6">{description}</p>
      {children}
    </div>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <div className="error">{(error as Error).message || String(error)}</div>
  ) : null;
}
export function Loading() {
  return (
    <div className="grid gap-4">
      <div className="skeleton" />
      <div className="skeleton h-48" />
    </div>
  );
}

export default function App() {
  const query = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<Session>("/auth/session"),
    staleTime: Infinity,
  });
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState("overview");
  const [editor, setEditor] = useState<Connection | null | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Connection>();
  const [passwordEditor, setPasswordEditor] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [mobile, setMobile] = useState(false);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("datahelm-theme") || "dark",
  );
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => api<Connection[]>("/connections"),
    enabled: !!session.data && !session.data.must_change_password,
    refetchInterval: 5000,
  });
  const current =
    page === "instances"
      ? undefined
      : connections.data?.find((c) => c.id === selected);
  const capabilities = useQuery({
    queryKey: ["capabilities", selected],
    queryFn: () => api(connectionPath(selected, "capabilities")),
    enabled: !!session.data && !session.data.must_change_password && !!current,
    staleTime: 60000,
    retry: false,
  });
  useEffect(() => {
    if (session.data) setCsrf(session.data.csrf_token);
  }, [session.data]);
  useEffect(() => {
    const expired = () => {
      setCsrf("");
      query.setQueryData(["session"], null);
      query.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [query]);
  useEffect(() => {
    if (
      connections.data?.length &&
      !connections.data.some((c) => c.id === selected)
    )
      setSelected(connections.data[0].id);
  }, [connections.data, selected]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "light",
        theme === "light" || (theme === "system" && !media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("datahelm-theme", theme);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  async function connectionSaved(id: string) {
    setEditor(undefined);
    try {
      // Fetch the post-save list before selecting: the fallback effect otherwise
      // sees an unknown new ID in the old cache and selects the first instance.
      await query.cancelQueries({ queryKey: ["connections"] });
      await query.fetchQuery({
        queryKey: ["connections"],
        queryFn: () => api<Connection[]>("/connections"),
        staleTime: 0,
      });
      setSelected(id);
      setPage("overview");
      void query.invalidateQueries({ queryKey: ["capabilities", id] });
      setToast("Connection saved");
    } catch (e) {
      setError(
        `Connection saved; refreshing the connection list failed: ${(e as Error).message}`,
      );
    }
  }
  async function remove() {
    if (!deleteTarget) return;
    try {
      await api(`/connections/${deleteTarget.id}`, "DELETE");
      setDeleteTarget(undefined);
      await query.invalidateQueries({ queryKey: ["connections"] });
      setToast("Connection removed");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function logout() {
    try {
      await api("/auth/logout", "POST");
      setCsrf("");
      query.setQueryData(["session"], null);
      query.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
      setSelected("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function passwordChanged(next: Session) {
    setCsrf(next.csrf_token);
    query.setQueryData(["session"], next);
    const protectedQueries = {
      predicate: (q: { queryKey: readonly unknown[] }) =>
        q.queryKey[0] !== "session",
    };
    void query
      .cancelQueries(protectedQueries)
      .then(() => query.invalidateQueries(protectedQueries));
    setPasswordEditor(false);
    setToast("Password changed. Other sessions have been signed out.");
  }
  if (session.isPending)
    return (
      <div className="login">
        <Loader2 className="animate-spin text-primary" />
      </div>
    );
  if (!session.data)
    return (
      <LoginForm
        onLogin={(s) => {
          setCsrf(s.csrf_token);
          query.setQueryData(["session"], s);
        }}
      />
    );
  if (session.data.must_change_password)
    return (
      <div className="login">
        <div className="card login-card password-setup">
          <Brand />
          <h1>Set your password</h1>
          <p className="text-sm text-muted-foreground mt-3 mb-6 leading-6">
            Choose a new password for {session.data.username} to finish setting
            up your workspace.
          </p>
          <PasswordForm firstLogin onChanged={passwordChanged} />
          <Button
            variant="ghost"
            className="mt-4 w-full"
            onClick={() => void logout()}
          >
            Sign out
          </Button>
          <ErrorBox error={error} />
        </div>
      </div>
    );
  const refresh = () => {
    void query.invalidateQueries({
      predicate: (q) =>
        q.queryKey[1] === selected || q.queryKey[0] === "connections",
    });
  };
  return (
    <div className="layout">
      <aside
        id="connections-navigation"
        className={`sidebar ${mobile ? "open" : ""}`}
      >
        <Brand />
        <Button
          className="mobile-toggle absolute right-3 top-5"
          size="icon"
          variant="ghost"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        >
          <ChevronRight size={17} />
        </Button>
        <div className="sidebar-section">WORKSPACE</div>
        <button
          className="connection-item"
          onClick={() => {
            setPage("instances");
          }}
        >
          <Gauge size={16} />
          <span>Database instances</span>
          <span className="ml-auto text-xs">
            {connections.data?.length || 0}
          </span>
        </button>
        <div className="sidebar-section flex justify-between items-center">
          SAVED CONNECTIONS
          <button
            onClick={() => setEditor(null)}
            aria-label="Add connection"
            className="text-primary"
          >
            <Plus size={15} />
          </button>
        </div>
        {connections.data?.map((c) => (
          <button
            className={`connection-item ${selected === c.id ? "active" : ""}`}
            key={c.id}
            onClick={() => {
              setSelected(c.id);
              setPage("overview");
              setMobile(false);
            }}
          >
            <Server size={15} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium truncate">
                {c.config.name}
              </span>
              <span className="block text-[10px] mt-1 text-muted-foreground">
                {engineLabel(c)} · {endpointLabel(c)}
              </span>
            </span>
            <span className={`status-dot ${c.status}`} aria-label={c.status} />
          </button>
        ))}
        {!connections.data?.length && (
          <p className="text-xs text-muted-foreground px-3 leading-6">
            Your saved instances will appear here.
          </p>
        )}
        <Button
          variant="outline"
          className="mt-4 w-full text-xs"
          onClick={() => setEditor(null)}
        >
          <Plus size={14} />
          Add connection
        </Button>
        <div className="notice mt-7 text-[11px]">
          <div className="flex gap-2 text-foreground items-center">
            <ShieldCheck size={14} className="text-primary" />
            Encrypted credential vault
          </div>
          <p className="mt-2">Your connection secrets stay on your server.</p>
        </div>
        <div className="sidebar-footer">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-xs font-medium">{session.data.username}</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Workspace administrator
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Change password"
                title="Change password"
                onClick={() => setPasswordEditor(true)}
              >
                <KeyRound size={15} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Sign out"
                onClick={() => void logout()}
              >
                <LogOut size={15} />
              </Button>
            </div>
          </div>
        </div>
      </aside>
      <main className="dashboard-main">
        <header className="topbar">
          <div className="topbar-leading">
            <Button
              size="icon"
              variant="ghost"
              className="mobile-toggle"
              onClick={() => setMobile(!mobile)}
              aria-label="Toggle navigation"
              aria-expanded={mobile}
              aria-controls="connections-navigation"
            >
              <Menu size={17} />
            </Button>
            <Breadcrumb className="topbar-breadcrumb">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <button type="button" onClick={() => setPage("instances")}>
                      Workspace
                    </button>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {current ? (
                    <BreadcrumbLink asChild>
                      <button
                        type="button"
                        onClick={() => setPage("instances")}
                      >
                        {engineLabel(current)}
                      </button>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>Databases</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {current && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="breadcrumb-current">
                      <BreadcrumbPage title={current.config.name}>
                        {current.config.name}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                )}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div className="theme-selector">
            <SelectControl
              label="Theme"
              value={theme}
              onValueChange={setTheme}
              options={themeOptions}
            />
          </div>
        </header>
        <div className="workspace">
          <ErrorBox error={error || connections.error} />
          {current ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {engineLabel(current)} control center
                  </div>
                  <h1>{current.config.name}</h1>
                  <p className="flex items-center gap-2">
                    <span className={`status-dot ${current.status}`} />
                    {current.status === "connected"
                      ? "Connected"
                      : current.status === "offline"
                        ? "Connection unavailable"
                        : current.status === "degraded"
                          ? "Limited monitoring access"
                          : "Awaiting first check"}
                    <span className="text-border">/</span>
                    <span className="mono text-[11px]">
                      {endpointLabel(current)}
                    </span>
                  </p>
                </div>
                <div className="toolbar">
                  <Button variant="outline" size="sm" onClick={refresh}>
                    <RefreshCw size={13} />
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Edit connection"
                    onClick={() => setEditor(current)}
                  >
                    <Settings2 size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete connection"
                    onClick={() => setDeleteTarget(current)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              <nav className="tabs" aria-label="Connection pages">
                {pages.map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setPage(key)}
                    className={`tab ${page === key ? "active" : ""}`}
                    aria-current={page === key ? "page" : undefined}
                  >
                    <Icon size={14} />
                    {current.config.engine === "clickhouse" && key === "queries"
                      ? "Query history"
                      : label}
                  </button>
                ))}
              </nav>
              {current.error && <ErrorBox error={current.error} />}
              <div key={current.id}>
                {current.config.engine === "clickhouse" ? (
                  <Suspense fallback={<Loading />}>
                    <ClickHouseViews
                      connection={current}
                      page={page}
                      capabilities={capabilities.data}
                      notify={setToast}
                    />
                  </Suspense>
                ) : (
                  <>
                    {page === "overview" && (
                      <Overview
                        connection={current}
                        capabilities={capabilities.data}
                      />
                    )}{" "}
                    {page === "databases" && <Catalog id={current.id} />}{" "}
                    {page === "access" && (
                      <Access id={current.id} notify={setToast} />
                    )}{" "}
                    {page === "operations" && (
                      <Operations id={current.id} notify={setToast} />
                    )}{" "}
                    {page === "queries" && (
                      <SlowQueries
                        id={current.id}
                        capabilities={capabilities.data}
                        notify={setToast}
                      />
                    )}{" "}
                    {page === "topology" && <Topology id={current.id} />}
                  </>
                )}
              </div>
              <footer className="content-footer">
                <span>Metrics collected every 5 seconds · 7-day retention</span>
                <span>
                  {current.last_check
                    ? `Last check ${new Date(current.last_check).toLocaleTimeString()}`
                    : "No status recorded"}
                  {current.last_success && current.status !== "connected"
                    ? ` · Last success ${new Date(current.last_success).toLocaleString()}`
                    : ""}
                </span>
              </footer>
            </>
          ) : (
            <div className="pt-12">
              <div className="eyebrow">Your infrastructure, in focus</div>
              <h1 className="text-4xl font-semibold tracking-tight">
                A clear view of your data.
              </h1>
              <p className="text-muted-foreground mt-4 leading-7 max-w-xl">
                Connect your MongoDB and ClickHouse instances, follow their
                health, and manage access from one secure workspace.
              </p>
              <Button className="mt-7" onClick={() => setEditor(null)}>
                <Plus size={15} />
                {connections.data?.length
                  ? "Add another instance"
                  : "Connect your first instance"}
                <ArrowUpRight size={15} />
              </Button>
              <div className="grid md:grid-cols-3 gap-5 mt-12">
                {[
                  [
                    Activity,
                    "Know what’s happening",
                    "Live connections, operation rates, and seven days of server history.",
                  ],
                  [
                    ShieldCheck,
                    "Keep access under control",
                    "Manage database users, custom roles, and their effective privileges.",
                  ],
                  [
                    Network,
                    "See the whole picture",
                    "Explore replica-set members, routers, and shard topology.",
                  ],
                ].map(([Icon, title, text]) => {
                  const I = Icon as typeof Activity;
                  return (
                    <div className="card p-6" key={title as string}>
                      <I size={20} className="text-primary mb-6" />
                      <h2 className="text-sm font-medium">{title as string}</h2>
                      <p className="text-xs text-muted-foreground mt-3 leading-6">
                        {text as string}
                      </p>
                    </div>
                  );
                })}
              </div>
              {connections.data?.length ? (
                <div className="grid md:grid-cols-2 gap-4 mt-8">
                  {connections.data.map((c) => (
                    <button
                      key={c.id}
                      className="card p-6 text-left hover:border-primary"
                      onClick={() => {
                        setSelected(c.id);
                        setPage("overview");
                      }}
                    >
                      <div className="flex justify-between items-center">
                        <h2 className="font-medium">{c.config.name}</h2>
                        <span className={`status-dot ${c.status}`} />
                      </div>
                      <p className="text-xs text-muted-foreground mt-4">
                        {c.status} · {engineLabel(c)} · {endpointLabel(c)}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="card mt-8">
                  <Empty
                    title="No connections yet"
                    description="Start with a connection URI or a host and authentication form. Add TLS certificates or an SSH tunnel when your deployment requires them."
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <footer className="app-footer" aria-label="Application version">
          <span>
            DataHelm <span className="mono">v{version}</span>
          </span>
        </footer>
      </main>
      {editor !== undefined && (
        <ConnectionEditor
          connection={editor || undefined}
          onClose={() => setEditor(undefined)}
          onSaved={(id) => void connectionSaved(id)}
        />
      )}
      <Dialog
        open={passwordEditor}
        onOpenChange={setPasswordEditor}
        title="Change password"
        description="Update your administrator password. Your current session will stay signed in."
      >
        <PasswordForm
          onChanged={passwordChanged}
          onCancel={() => setPasswordEditor(false)}
        />
      </Dialog>
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(undefined)}
        title="Remove saved connection?"
        description={`This removes ${deleteTarget?.config.name} and its metrics history from DataHelm. The database server is unaffected.`}
      >
        <div className="form-footer">
          <Button variant="outline" onClick={() => setDeleteTarget(undefined)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void remove()}>
            Remove connection
          </Button>
        </div>
      </Dialog>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
function LoginForm({ onLogin }: { onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        className="card login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            onLogin(await api("/auth/login", "POST", { username, password }));
            setPassword("");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Brand />
        <h1>Sign in to DataHelm</h1>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="error mt-4">{error}</div>}
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}Sign in
          <ArrowUpRight size={15} />
        </Button>
      </form>
    </div>
  );
}
