import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownToLine,
  Database,
  HardDrive,
  Network,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  X,
  ShieldCheck,
  GitBranch,
  Clock3,
  Search,
  ChevronRight,
  Layers,
  Play,
  Square,
} from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { api, connectionPath, type Connection, type Metric } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { SelectControl } from "./components/ui/select";
import AccessEditor from "./AccessEditor";
import { Empty, ErrorBox, Loading } from "./App";
import {
  formatBytes,
  formatNumber,
  dateValue,
  dateTimestamp,
} from "./lib/utils";
const dbQuery = (db: string) => `db=${encodeURIComponent(db)}`;
function Card({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-heading">
        <div>
          <h2 className="card-title">{title}</h2>
          {description && <p className="card-description">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Details({
  value,
  onClose,
  title = "Details",
}: {
  value: any;
  onClose: () => void;
  title?: string;
}) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={title} wide>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </Dialog>
  );
}
export function Overview({
  connection,
  capabilities,
}: {
  connection: Connection;
  capabilities: any;
}) {
  const [range, setRange] = useState(1800000);
  const metrics = useQuery({
    queryKey: ["metrics", connection.id, range],
    queryFn: () => {
      const to = Date.now();
      return api<Metric[]>(
        connectionPath(connection.id, `metrics?from=${to - range}&to=${to}`),
      );
    },
    refetchInterval: 5000,
  });
  const data = metrics.data || [];
  const live = useQuery({
    queryKey: ["metric-latest", connection.id],
    queryFn: () =>
      api<Metric | null>(connectionPath(connection.id, "metrics/latest")),
    refetchInterval: 5000,
  });
  const latest = live.data;
  const stale = latest && Date.now() - latest.timestamp > 30000;
  const charts = data.map((m) => ({
    ...m,
    time: new Date(m.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    memory_mb: m.memory_bytes == null ? null : m.memory_bytes / 1048576,
  }));
  return (
    <>
      <div className="stats-grid">
        {[
          [
            Network,
            "Active connections",
            formatNumber(latest?.connections),
            "Current server connections",
          ],
          [
            Activity,
            "Operations / second",
            formatNumber(latest?.ops_per_second),
            "Calculated from server counters",
          ],
          [
            HardDrive,
            "Resident memory",
            formatBytes(latest?.memory_bytes),
            "Memory used by MongoDB",
          ],
          [
            GitBranch,
            "Replication lag",
            latest?.replication_lag_seconds == null
              ? "—"
              : `${formatNumber(latest.replication_lag_seconds)} s`,
            "Largest healthy secondary lag",
          ],
        ].map(([Icon, label, value, description]) => {
          const I = Icon as typeof Activity;
          return (
            <div className="card stat" key={label as string}>
              <div className="stat-label">
                {label as string}
                <I size={15} />
              </div>
              <div className="stat-value">{value as string}</div>
              <div className="stat-meta">{description as string}</div>
            </div>
          );
        })}
      </div>
      <ErrorBox error={metrics.error || live.error} />
      {stale && (
        <div className="notice">
          The last sample is stale. Waiting for the next successful collection.
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2 items-center">
          <span
            className={`status-dot ${connection.config.monitoring ? "connected" : ""}`}
          />
          <span className="text-xs text-muted-foreground">
            {connection.config.monitoring
              ? "Live telemetry"
              : "Monitoring paused"}
          </span>
        </div>
        <SelectControl
          label="Metrics time range"
          value={range}
          onValueChange={(value) => setRange(Number(value))}
          className="!w-auto !py-1.5 text-xs"
          options={[
            { value: 1800000, label: "Last 30 minutes" },
            { value: 21600000, label: "Last 6 hours" },
            { value: 86400000, label: "Last 24 hours" },
            { value: 604800000, label: "Last 7 days" },
          ]}
        />
      </div>
      <div className="chart-grid">
        <Card
          title="Operation throughput"
          description="Operations per second across the selected time range"
          action={<span className="badge green">OPS / SEC</span>}
        >
          {data.length ? (
            <Chart data={charts} field="ops_per_second" />
          ) : (
            <Empty
              title="Waiting for telemetry"
              description="Charts populate after two successful samples. Monitoring runs on the server even while this page is closed."
            />
          )}
        </Card>
        <Card
          title="Memory usage"
          description="Resident memory · megabytes"
          action={<HardDrive size={14} className="text-muted-foreground" />}
        >
          {data.length ? (
            <Chart data={charts} field="memory_mb" color="#92a8ff" />
          ) : (
            <Empty
              title="No memory samples"
              description="Memory values appear when serverStatus is permitted for this connection."
            />
          )}
        </Card>
      </div>
      <div className="chart-grid">
        <Card
          title="Connection activity"
          description="Open connections over time"
        >
          {data.length ? (
            <Chart data={charts} field="connections" />
          ) : (
            <Empty
              title="No connection samples"
              description="The next successful server check will appear here."
            />
          )}
        </Card>
        <Card
          title="Instance details"
          description="Connection and topology information"
        >
          <div className="p-5">
            {[
              [
                "Server type",
                capabilities?.hello?.msg === "isdbgrid"
                  ? "Sharded router"
                  : capabilities?.hello?.setName
                    ? "Replica set"
                    : capabilities
                      ? "Standalone"
                      : "Detecting…",
              ],
              ["Replica set", capabilities?.hello?.setName || "—"],
              [
                "MongoDB version",
                capabilities?.server_version || "Unavailable",
              ],
              ["Connected node", latest?.source || "—"],
              [
                "Connection latency",
                connection.latency_ms != null
                  ? `${connection.latency_ms} ms`
                  : "—",
              ],
              [
                "Authentication",
                capabilities?.authentication?.mechanism || "—",
              ],
              [
                "TLS transport",
                connection.config.tls.enabled
                  ? "Enabled"
                  : connection.config.mode === "uri"
                    ? "Defined by saved URI"
                    : "Disabled",
              ],
              [
                "SSH tunnel",
                connection.config.ssh.enabled ? "Enabled" : "Disabled",
              ],
            ].map(([label, value]) => (
              <div
                className="flex justify-between gap-4 py-3 border-b border-border last:border-0 text-xs"
                key={label}
              >
                <span className="text-muted-foreground">{label}</span>
                <span className="mono text-right break-all">{value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card
        title="Operation counters"
        description="Latest server counters and calculated rates"
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Total counter</th>
                <th>Operations / second</th>
              </tr>
            </thead>
            <tbody>
              {[
                "insert",
                "query",
                "update",
                "delete",
                "getmore",
                "command",
              ].map((name) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td className="mono">
                    {formatNumber((latest?.opcounters as any)?.[name])}
                  </td>
                  <td className="mono">
                    {formatNumber((latest?.rates as any)?.[name])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
function Chart({
  data,
  field,
  color = "#52d9a2",
}: {
  data: any[];
  field: string;
  color?: string;
}) {
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          accessibilityLayer
          aria-label={`${field.replaceAll("_", " ")} chart`}
        >
          <defs>
            <linearGradient id={`fill-${field}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            stroke="var(--border)"
            strokeDasharray="3 5"
          />
          <XAxis
            dataKey="time"
            tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            minTickGap={50}
          />
          <YAxis
            tickFormatter={formatNumber}
            tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={50}
          />
          <Tooltip
            formatter={(value) => formatNumber(value)}
            labelFormatter={(_, p) =>
              p?.[0]?.payload?.timestamp
                ? new Date(p[0].payload.timestamp).toLocaleString()
                : ""
            }
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 7,
              fontSize: 11,
            }}
          />
          <Area
            name={field.replaceAll("_", " ")}
            type="monotone"
            dataKey={field}
            stroke={color}
            strokeWidth={2}
            fill={`url(#fill-${field})`}
            connectNulls={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Catalog({ id }: { id: string }) {
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [details, setDetails] = useState<any>();
  const databases = useQuery({
    queryKey: ["databases", id],
    queryFn: () => api(connectionPath(id, "databases")),
  });
  const db = selected || databases.data?.[0]?.name || "";
  const collections = useQuery({
    queryKey: ["collections", id, db],
    queryFn: () => api(connectionPath(id, `collections?${dbQuery(db)}`)),
    enabled: !!db,
  });
  if (databases.isPending) return <Loading />;
  return (
    <>
      <ErrorBox error={databases.error} />
      <div className="catalog-layout">
        <Card
          title="Databases"
          action={<span className="badge">{databases.data?.length || 0}</span>}
        >
          {databases.data?.map((d: any) => (
            <button
              key={d.name}
              className={`database-button ${db === d.name ? "active" : ""}`}
              onClick={() => setSelected(d.name)}
            >
              <Database size={14} />
              <span className="flex-1 truncate">{d.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {d.stats?.collections ?? "—"}
              </span>
            </button>
          ))}
          {!databases.data?.length && (
            <Empty
              title="No databases"
              description="No databases are visible to this user."
            />
          )}
        </Card>
        <div>
          <div className="stats-grid !grid-cols-3">
            {[
              [
                "Collections",
                formatNumber(
                  databases.data?.find((d: any) => d.name === db)?.stats
                    ?.collections,
                ),
              ],
              [
                "Data size",
                formatBytes(
                  databases.data?.find((d: any) => d.name === db)?.stats
                    ?.dataSize,
                ),
              ],
              [
                "Indexes",
                formatNumber(
                  databases.data?.find((d: any) => d.name === db)?.stats
                    ?.indexes,
                ),
              ],
            ].map(([label, value]) => (
              <div className="card p-4" key={label}>
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className="text-xl mt-3">{value}</p>
              </div>
            ))}
          </div>
          <ErrorBox
            error={
              collections.error ||
              databases.data?.find((d: any) => d.name === db)?.error
            }
          />
          <Card
            title={db || "Collections"}
            description="Collection metadata · read-only"
            action={
              <input
                aria-label="Search collections"
                placeholder="Search collections…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="!w-44 !py-1.5 text-xs"
              />
            }
          >
            {collections.isPending ? (
              <Loading />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Collection</th>
                      <th>Documents</th>
                      <th>Data size</th>
                      <th>Storage</th>
                      <th>Indexes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collections.data
                      ?.filter((c: any) =>
                        c.name.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((c: any) => (
                        <tr key={c.name}>
                          <td>
                            <button
                              className="flex gap-2 items-center hover:text-primary"
                              onClick={async () => {
                                try {
                                  setDetails(
                                    await api(
                                      connectionPath(
                                        id,
                                        `indexes?${dbQuery(db)}&collection=${encodeURIComponent(c.name)}`,
                                      ),
                                    ),
                                  );
                                } catch (e) {
                                  setDetails({ error: (e as Error).message });
                                }
                              }}
                            >
                              <Layers
                                size={14}
                                className="text-muted-foreground"
                              />
                              <span>{c.name}</span>
                              <ChevronRight size={12} />
                            </button>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              {c.error ||
                                (c.bucket_count != null
                                  ? `${c.kind} · ${formatNumber(c.bucket_count)} buckets · measurement count unavailable`
                                  : c.kind)}
                            </p>
                          </td>
                          <td className="mono">{formatNumber(c.count)}</td>
                          <td className="mono">{formatBytes(c.size)}</td>
                          <td className="mono">
                            {formatBytes(c.storage_size)}
                          </td>
                          <td className="mono">{formatNumber(c.indexes)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {collections.data?.length === 0 && (
                  <Empty
                    title="No collections"
                    description="This database has no visible collections."
                  />
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
      {details && (
        <Details
          title="Collection indexes"
          value={details}
          onClose={() => setDetails(undefined)}
        />
      )}
    </>
  );
}

export function Operations({
  id,
  notify,
}: {
  id: string;
  notify: (s: string) => void;
}) {
  const cache = useQueryClient();
  const capabilities = useQuery({
    queryKey: ["capabilities", id],
    queryFn: () => api(connectionPath(id, "capabilities")),
    staleTime: 60000,
  });
  const [search, setSearch] = useState("");
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [target, setTarget] = useState<any>();
  const [details, setDetails] = useState<any>();
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["operations", id],
    queryFn: () => api(connectionPath(id, "operations")),
    refetchInterval: paused ? false : 5000,
  });
  const rows =
    query.data?.filter(
      (r: any) =>
        (r.operation.secs_running || 0) >= duration &&
        JSON.stringify(r.operation)
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) || [];
  return (
    <>
      <ErrorBox error={query.error || error} />
      <Card
        title="Current operations"
        description="Active client operations on the connected node · refreshes every 5 seconds"
        action={
          <div className="toolbar">
            <input
              aria-label="Search operations"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Namespace or client…"
            />
            <SelectControl
              label="Minimum operation duration"
              value={duration}
              onValueChange={(value) => setDuration(Number(value))}
              className="!w-auto !py-1.5 text-xs"
              options={[
                { value: 0, label: "All durations" },
                { value: 5, label: "Over 5 seconds" },
                { value: 30, label: "Over 30 seconds" },
                { value: 60, label: "Over 1 minute" },
              ]}
            />
            <Button
              size="icon"
              variant="outline"
              onClick={() => setPaused(!paused)}
              aria-label={paused ? "Resume updates" : "Pause updates"}
            >
              {paused ? <Play size={13} /> : <Square size={13} />}
            </Button>
          </div>
        }
      >
        {query.isPending ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Namespace</th>
                  <th>Duration</th>
                  <th>Client</th>
                  <th>Node</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <button
                        className="text-primary"
                        onClick={() => setDetails(row.operation)}
                      >
                        {row.operation.op || "command"}
                      </button>
                    </td>
                    <td className="mono">{row.operation.ns || "—"}</td>
                    <td className="mono">
                      {formatNumber(row.operation.secs_running)} s
                    </td>
                    <td className="mono text-[10px]">
                      {row.operation.client || "internal"}
                    </td>
                    <td className="mono text-[10px]">{row.source}</td>
                    <td>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={
                          !row.killable ||
                          capabilities.data?.features?.kill_operations
                            ?.available === false
                        }
                        onClick={() => setTarget(row)}
                      >
                        Kill operation
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <Empty
                title="No matching operations"
                description="Active operations will appear here. Internal maintenance operations cannot be terminated from this dashboard."
              />
            )}
          </div>
        )}
      </Card>
      {details && (
        <Details
          title="Operation details"
          value={details}
          onClose={() => setDetails(undefined)}
        />
      )}
      <Dialog
        open={!!target}
        onOpenChange={(v) => !v && setTarget(undefined)}
        title="Kill this operation?"
        description={`Request cancellation of the client operation on ${target?.source}. MongoDB may need time to interrupt it.`}
      >
        <p className="mono text-xs">{target?.operation.ns}</p>
        <div className="form-footer">
          <Button variant="outline" onClick={() => setTarget(undefined)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              try {
                await api(connectionPath(id, "operations/kill"), "POST", {
                  token: target.token,
                });
                setTarget(undefined);
                await cache.invalidateQueries({ queryKey: ["operations", id] });
                notify("Operation cancellation requested");
              } catch (e) {
                setError((e as Error).message);
                setTarget(undefined);
              }
            }}
          >
            Confirm cancellation
          </Button>
        </div>
      </Dialog>
    </>
  );
}

export function SlowQueries({
  id,
  capabilities,
  notify,
}: {
  id: string;
  capabilities: any;
  notify: (s: string) => void;
}) {
  const cache = useQueryClient();
  const [db, setDb] = useState("");
  const [source, setSource] = useState("profiler");
  const [before, setBefore] = useState<number>();
  const [skip, setSkip] = useState(0);
  const [threshold, setThreshold] = useState("");
  const [minimum, setMinimum] = useState(0);
  const [details, setDetails] = useState<any>();
  const [error, setError] = useState("");
  const databases = useQuery({
    queryKey: ["databases", id],
    queryFn: () => api(connectionPath(id, "databases")),
  });
  const selected = db || databases.data?.[0]?.name || "admin";
  const settings = useQuery({
    queryKey: ["profiler", id, selected],
    queryFn: () => api(connectionPath(id, `profiler?${dbQuery(selected)}`)),
    enabled:
      source === "profiler" &&
      capabilities?.features?.profiler?.available !== false,
  });
  const profiles = useQuery({
    queryKey: ["profiles", id, selected, before, skip, minimum, source],
    queryFn: () =>
      api(
        connectionPath(
          id,
          source === "logs"
            ? "logs"
            : `profiles?${dbQuery(selected)}&min_ms=${minimum}${before ? `&before=${before}&skip=${skip}` : ""}`,
        ),
      ),
    enabled:
      source === "logs" ||
      capabilities?.features?.profiler?.available !== false,
  });
  const items = profiles.data?.items || [];
  async function changeProfiler(enabled: boolean, slow_ms?: number) {
    setError("");
    try {
      await api(connectionPath(id, "profiler"), "PUT", {
        db: selected,
        enabled,
        slow_ms,
      });
      await cache.invalidateQueries({ queryKey: ["profiler", id] });
      notify(enabled ? "Slow-query profiling enabled" : "Profiling disabled");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="toolbar mb-5">
        <SelectControl
          label="Slow query source"
          className="!w-auto"
          value={source}
          onValueChange={(value) => {
            setSource(value);
            setBefore(undefined);
          }}
          options={[
            { value: "profiler", label: "Database profiler" },
            { value: "logs", label: "Recent diagnostic slow log" },
          ]}
        />
        <SelectControl
          label="Profiler database"
          className="!w-auto"
          value={selected}
          onValueChange={(value) => {
            setDb(value);
            setBefore(undefined);
          }}
          options={(databases.data || [{ name: "admin" }]).map((d: any) => ({
            value: d.name,
            label: d.name,
          }))}
        />
      </div>
      <ErrorBox error={error || profiles.error || settings.error} />
      {source === "profiler" && (
        <Card
          title="Database profiler"
          description={`Node-specific profiling for ${selected}`}
          action={
            <span className={`badge ${settings.data?.was > 0 ? "green" : ""}`}>
              {settings.data?.was > 0 ? "ENABLED" : "DISABLED"}
            </span>
          }
        >
          <div className="p-5 flex flex-wrap items-center gap-4">
            <div className="flex-1 text-xs text-muted-foreground leading-6">
              {capabilities?.features?.profiler_write?.reason ||
                capabilities?.features?.profiler?.reason ||
                "Profiling captures query details and can add overhead. Existing filters and sampling settings are preserved. Threshold changes also affect this node’s diagnostic slow logging."}
              <p className="mono text-[10px] mt-2">
                Current threshold: {settings.data?.slowms ?? "—"} ms · sample
                rate: {settings.data?.sampleRate ?? "—"}
              </p>
            </div>
            <label>
              Slow threshold (ms)
              <input
                type="number"
                min={0}
                max={600000}
                className="!w-32"
                value={threshold}
                placeholder={String(settings.data?.slowms ?? 100)}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
            <Button
              variant="outline"
              disabled={
                !threshold ||
                !settings.data ||
                capabilities?.features?.profiler_write?.available === false
              }
              onClick={() =>
                void changeProfiler(settings.data?.was > 0, Number(threshold))
              }
            >
              Apply threshold
            </Button>
            <Button
              disabled={
                !settings.data ||
                capabilities?.features?.profiler_write?.available === false
              }
              onClick={() => void changeProfiler(!(settings.data?.was > 0))}
            >
              {settings.data?.was > 0 ? (
                <Square size={13} />
              ) : (
                <Play size={13} />
              )}{" "}
              {settings.data?.was > 0
                ? "Disable profiler"
                : "Enable slow profiling"}
            </Button>
          </div>
        </Card>
      )}
      <div className="mt-5">
        <Card
          title={
            source === "profiler"
              ? "Profiled queries"
              : "Recent slow-log entries"
          }
          description={
            source === "profiler"
              ? "Newest first · up to 100 entries per page"
              : "MongoDB diagnostic buffer only; not the full server log archive"
          }
          action={
            <SelectControl
              label="Minimum query duration"
              className="!w-auto !py-1.5 text-xs"
              value={minimum}
              onValueChange={(value) => {
                setMinimum(Number(value));
                setBefore(undefined);
              }}
              options={[
                { value: 0, label: "All durations" },
                { value: 100, label: "100 ms or more" },
                { value: 1000, label: "1 second or more" },
              ]}
            />
          }
        >
          {profiles.isPending ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Namespace</th>
                    <th>Duration</th>
                    <th>Documents examined</th>
                    <th>Keys examined</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items
                    .filter(
                      (r: any) =>
                        (r.millis ?? r.attr?.durationMillis ?? 0) >= minimum,
                    )
                    .map((r: any, i: number) => (
                      <tr key={i}>
                        <td className="text-[10px]">
                          {dateValue(r.ts || r.t)}
                        </td>
                        <td className="mono">{r.ns || r.attr?.ns || "—"}</td>
                        <td className="mono">
                          {formatNumber(r.millis ?? r.attr?.durationMillis)} ms
                        </td>
                        <td className="mono">
                          {formatNumber(r.docsExamined ?? r.attr?.docsExamined)}
                        </td>
                        <td className="mono">
                          {formatNumber(r.keysExamined ?? r.attr?.keysExamined)}
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDetails(r)}
                          >
                            View query
                            <ChevronRight size={12} />
                          </Button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!items.length && (
                <Empty
                  title="No slow queries found"
                  description="Enable the profiler on a direct mongod connection to collect queries, or inspect the recent diagnostic slow log."
                />
              )}
            </div>
          )}
        </Card>
        <div className="flex justify-end gap-3 mt-4">
          {before && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBefore(undefined)}
            >
              Newest entries
            </Button>
          )}
          {profiles.data?.next_before && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBefore(profiles.data.next_before);
                setSkip(profiles.data.next_skip || 0);
              }}
            >
              Older entries
              <ChevronRight size={12} />
            </Button>
          )}
        </div>
      </div>
      {details && (
        <Details
          title="Slow query details"
          value={details}
          onClose={() => setDetails(undefined)}
        />
      )}
    </>
  );
}

export function Topology({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ["topology", id],
    queryFn: () => api(connectionPath(id, "topology")),
    refetchInterval: 15000,
  });
  const [details, setDetails] = useState<any>();
  if (query.isPending) return <Loading />;
  const v = query.data;
  const members =
    v?.replica?.members ||
    v?.hello?.hosts?.map((name: string) => ({
      name,
      stateStr: name === v.hello.primary ? "PRIMARY" : "MEMBER",
    })) ||
    [];
  const primary = members.find((m: any) => m.stateStr === "PRIMARY");
  const lag = (member: any) => {
    if (!primary?.optimeDate || !member.optimeDate) return "—";
    const parse = (d: any) => dateTimestamp(d);
    return `${formatNumber(Math.max(0, (parse(primary.optimeDate) - parse(member.optimeDate)) / 1000))} s`;
  };
  return (
    <>
      <ErrorBox error={query.error} />
      {v && (
        <>
          <div className="stats-grid !grid-cols-3">
            {[
              [
                "Deployment",
                v.hello.msg === "isdbgrid"
                  ? "Sharded cluster"
                  : v.hello.setName
                    ? "Replica set"
                    : "Standalone",
              ],
              ["Replica set", v.hello.setName || "—"],
              [
                "Members / shards",
                members.length || v.shards?.shards?.length || 1,
              ],
            ].map(([label, value]) => (
              <div className="card p-5" key={String(label)}>
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className="text-xl mt-3">{value}</p>
              </div>
            ))}
          </div>
          <Card
            title="Deployment topology"
            description="Reported by the connected node · refreshes every 15 seconds"
            action={
              <Button variant="ghost" size="sm" onClick={() => setDetails(v)}>
                Raw details
                <ChevronRight size={12} />
              </Button>
            }
          >
            <div className="topology-grid">
              {members.length ? (
                members.map((m: any) => (
                  <div
                    className={`node ${m.stateStr === "PRIMARY" ? "primary" : ""}`}
                    key={m.name}
                  >
                    <div className="flex justify-between">
                      <ServerIcon />
                      <span
                        className={`badge ${m.stateStr === "PRIMARY" ? "green" : ""}`}
                      >
                        {m.stateStr || "UNKNOWN"}
                      </span>
                    </div>
                    <h3 className="node-name mono">{m.name}</h3>
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>
                        Health:{" "}
                        {m.health === 1
                          ? "Healthy"
                          : m.health === 0
                            ? "Unreachable"
                            : "Unknown"}
                      </span>
                      <span>
                        Lag: {m.stateStr === "PRIMARY" ? "0 s" : lag(m)}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="node primary">
                  <Network size={20} className="text-primary" />
                  <h3 className="node-name mono">
                    {v.hello.me || v.hello.primary || "Connected node"}
                  </h3>
                  <span className="badge green">
                    {v.hello.msg === "isdbgrid"
                      ? "MONGOS ROUTER"
                      : "STANDALONE"}
                  </span>
                </div>
              )}
              {v.shards?.shards?.map((s: any) => (
                <div className="node" key={s._id}>
                  <Layers size={20} className="text-primary" />
                  <h3 className="node-name">{s._id}</h3>
                  <p className="mono text-[10px] text-muted-foreground break-all">
                    {s.host}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-4">
                    Direct connections provide member health and profiling.
                  </p>
                </div>
              ))}
              {v.routers?.map((r: any) => (
                <div className="node" key={r._id}>
                  <Network size={20} />
                  <h3 className="node-name mono">{r._id}</h3>
                  <span className="badge">ROUTER</span>
                  <p className="text-[10px] text-muted-foreground mt-3">
                    Last ping: {dateValue(r.ping)}
                  </p>
                </div>
              ))}
            </div>
          </Card>
          {v.shards?.error && (
            <div className="notice">
              Shard metadata unavailable: {v.shards.error}
            </div>
          )}
          {!v.replica && v.hello.setName && (
            <div className="notice">
              Replica-set membership is visible, but detailed health and lag
              require replSetGetStatus privileges.
            </div>
          )}
        </>
      )}
      {details && (
        <Details
          title="Topology metadata"
          value={details}
          onClose={() => setDetails(undefined)}
        />
      )}
    </>
  );
}
function ServerIcon() {
  return <Network size={20} className="text-primary" />;
}

export function Access({
  id,
  notify,
}: {
  id: string;
  notify: (s: string) => void;
}) {
  const cache = useQueryClient();
  const capabilities = useQuery({
    queryKey: ["capabilities", id],
    queryFn: () => api(connectionPath(id, "capabilities")),
    staleTime: 60000,
  });
  const [tab, setTab] = useState("users");
  const [db, setDb] = useState("");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<any>();
  const [target, setTarget] = useState<any>();
  const [details, setDetails] = useState<any>();
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: [tab, id, db],
    queryFn: () =>
      api(connectionPath(id, `${tab}${db ? `?${dbQuery(db)}` : ""}`)),
  });
  const rows = (query.data?.[tab] || []).filter((r: any) =>
    `${r.user || r.role} ${r.db}`.toLowerCase().includes(search.toLowerCase()),
  );
  const noun = tab === "users" ? "user" : "role";
  async function inspect(row: any) {
    setError("");
    try {
      setDetails(
        await api(
          connectionPath(
            id,
            `${tab}?${dbQuery(row.db)}&name=${encodeURIComponent(row.user || row.role)}`,
          ),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="flex justify-between flex-wrap gap-3 mb-5">
        <div className="flex gap-2">
          <Button
            variant={tab === "users" ? "default" : "outline"}
            onClick={() => setTab("users")}
          >
            Users
          </Button>
          <Button
            variant={tab === "roles" ? "default" : "outline"}
            onClick={() => {
              setTab("roles");
              if (!db) setDb("admin");
            }}
          >
            Roles
          </Button>
        </div>
        <Button
          disabled={
            capabilities.data?.features?.[`create_${noun}`]?.available === false
          }
          title={
            capabilities.data?.features?.[`create_${noun}`]?.reason || undefined
          }
          onClick={() => setEdit({ create: true, db: db || "admin" })}
        >
          <Plus size={14} />
          Create {noun}
        </Button>
      </div>
      <ErrorBox error={query.error || error} />
      <Card
        title={tab === "users" ? "Database users" : "Database roles"}
        description={
          tab === "users"
            ? "Authentication mechanisms and assigned database roles"
            : "Built-in and custom roles with inherited privileges"
        }
        action={
          <div className="toolbar">
            <input
              value={db}
              onChange={(e) => setDb(e.target.value)}
              placeholder={
                tab === "users"
                  ? "All authentication databases"
                  : "Role database"
              }
              aria-label="Authentication or role database"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${tab}…`}
              aria-label={`Search ${tab}`}
            />
          </div>
        }
      >
        {query.isPending ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{noun}</th>
                  <th>Database</th>
                  <th>{tab === "users" ? "Authentication" : "Type"}</th>
                  <th>Assigned roles</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={`${r.db}:${r.user || r.role}`}>
                    <td>
                      <button
                        className="text-primary flex items-center gap-2"
                        onClick={() => void inspect(r)}
                      >
                        <ShieldCheck size={14} />
                        {r.user || r.role}
                        <ChevronRight size={12} />
                      </button>
                    </td>
                    <td className="mono">{r.db}</td>
                    <td>
                      {tab === "users" ? (
                        <span className="text-[10px]">
                          {r.mechanisms?.join(", ") ||
                            (r.db === "$external"
                              ? "External authentication"
                              : "Unknown")}
                        </span>
                      ) : (
                        <span
                          className={`badge ${!r.isBuiltin ? "green" : ""}`}
                        >
                          {r.isBuiltin ? "BUILT-IN" : "CUSTOM"}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {r.roles?.map((role: any) => (
                          <span
                            className="badge"
                            key={`${role.db}:${role.role}`}
                          >
                            {role.db} / {role.role}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${r.user || r.role}`}
                          disabled={
                            r.isBuiltin ||
                            capabilities.data?.features?.[`update_${noun}`]
                              ?.available === false
                          }
                          onClick={() => setEdit(r)}
                        >
                          <Pencil size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${r.user || r.role}`}
                          disabled={
                            r.isBuiltin ||
                            capabilities.data?.features?.[`delete_${noun}`]
                              ?.available === false
                          }
                          onClick={() => setTarget(r)}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <Empty
                title={`No ${tab} found`}
                description="Choose a database where your connected MongoDB account has permission to view access settings."
              />
            )}
          </div>
        )}
      </Card>
      {edit && (
        <AccessEditor
          id={id}
          kind={noun}
          row={edit}
          onClose={() => setEdit(undefined)}
          onSave={async (body) => {
            await api(
              connectionPath(id, tab),
              edit.create ? "POST" : "PATCH",
              body,
            );
            setEdit(undefined);
            await cache.invalidateQueries({ queryKey: [tab, id] });
            if (tab === "roles")
              await cache.invalidateQueries({ queryKey: ["role-options", id] });
            notify(`${noun === "user" ? "User" : "Role"} saved`);
          }}
        />
      )}
      <Dialog
        open={!!target}
        onOpenChange={(v) => !v && setTarget(undefined)}
        title={`Delete this ${noun}?`}
        description={`Remove ${target?.user || target?.role} from ${target?.db}. This changes MongoDB access immediately.`}
      >
        <div className="form-footer">
          <Button variant="outline" onClick={() => setTarget(undefined)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              try {
                await api(connectionPath(id, tab), "DELETE", {
                  db: target.db,
                  name: target.user || target.role,
                });
                setTarget(undefined);
                await cache.invalidateQueries({ queryKey: [tab, id] });
                if (tab === "roles")
                  await cache.invalidateQueries({
                    queryKey: ["role-options", id],
                  });
                notify(`${noun} deleted`);
              } catch (e) {
                setError((e as Error).message);
                setTarget(undefined);
              }
            }}
          >
            Delete {noun}
          </Button>
        </div>
      </Dialog>
      {details && (
        <AccessDetails
          value={details}
          kind={noun}
          onClose={() => setDetails(undefined)}
        />
      )}
    </>
  );
}
function AccessDetails({
  value,
  kind,
  onClose,
}: {
  value: any;
  kind: string;
  onClose: () => void;
}) {
  const detail = value[kind === "user" ? "users" : "roles"]?.[0];
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={`${detail?.user || detail?.role || "Access"} · effective privileges`}
      description="Privileges expanded from assigned and inherited roles."
      wide
    >
      {detail?.inheritedPrivileges && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Resource</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {detail.inheritedPrivileges.map((p: any, i: number) => (
                <tr key={i}>
                  <td className="mono text-[10px]">
                    {p.resource.cluster
                      ? "Cluster"
                      : p.resource.anyResource
                        ? "All resources"
                        : `${p.resource.db || "All databases"} / ${p.resource.collection || "All collections"}`}
                  </td>
                  <td className="text-xs">{p.actions.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <pre>{JSON.stringify(detail || value, null, 2)}</pre>
    </Dialog>
  );
}
