import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { api, connectionPath, type Connection, type Metric } from "./api";
import { chApi, useCH, type CH } from "./clickhouse-api";
import { Panel, Grid, Result } from "./ClickHouseUI";
import ClickHouseAccess from "./ClickHouseAccess";
import { Button } from "./components/ui/button";
import { SelectControl } from "./components/ui/select";
import { Dialog } from "./components/ui/dialog";
import { formatBytes, formatNumber } from "./lib/utils";
import { ErrorBox, Empty } from "./App";

export default function ClickHouseViews({
  connection,
  page,
  capabilities,
  notify,
}: {
  connection: Connection;
  page: string;
  capabilities?: CH<"Capabilities">;
  notify: (message: string) => void;
}) {
  const id = connection.id;
  return (
    <>
      <p className="notice">
        Connected server only · SQL-managed access · No ON CLUSTER.
        Server-configured replication may propagate access changes.
      </p>
      {page === "overview" && (
        <Overview connection={connection} capabilities={capabilities} />
      )}
      {page === "databases" && <Catalog id={id} />}
      {page === "access" && (
        <ClickHouseAccess id={id} capabilities={capabilities} notify={notify} />
      )}
      {page === "operations" && (
        <Queries id={id} capabilities={capabilities} notify={notify} />
      )}
      {page === "queries" && <History id={id} />}
      {page === "topology" && <Replicas id={id} />}
    </>
  );
}
function Overview({
  connection,
  capabilities,
}: {
  connection: Connection;
  capabilities?: CH<"Capabilities">;
}) {
  const [range, setRange] = useState("1800000");
  const [series, setSeries] = useState("queries_per_second");
  const latest = useQuery({
    queryKey: ["clickhouse", connection.id, "latest"],
    queryFn: () =>
      api<Metric | null>(connectionPath(connection.id, "metrics/latest")),
    refetchInterval: 5000,
    retry: false,
  });
  const history = useQuery({
    queryKey: ["clickhouse", connection.id, "metrics", range],
    queryFn: () =>
      api<Metric[]>(
        connectionPath(
          connection.id,
          `metrics?from=${Date.now() - Number(range)}&to=${Date.now()}`,
        ),
      ),
    refetchInterval: 5000,
    retry: false,
  });
  const m = latest.data;
  const data =
    history.data?.map((r) => ({
      timestamp: r.timestamp,
      value: r.error
        ? null
        : series === "memory_bytes"
          ? r.memory_bytes
          : (r.clickhouse?.[series as keyof CH<"ClickHouseMetric">] ?? null),
    })) || [];
  return (
    <>
      <ErrorBox error={latest.error || history.error || m?.error} />
      {!connection.config.monitoring && (
        <p className="notice">Monitoring is disabled for this connection.</p>
      )}
      {m && Date.now() - m.timestamp > 30000 && (
        <p className="notice">
          The last sample is stale. Waiting for monitoring to recover.
        </p>
      )}
      <div className="grid md:grid-cols-4 gap-4 mb-5">
        {[
          ["Memory tracking", formatBytes(m?.memory_bytes)],
          ["Active queries", formatNumber(m?.clickhouse?.active_queries)],
          ["Queries / second", formatNumber(m?.clickhouse?.queries_per_second)],
          [
            "Disk read / second",
            `${formatBytes(m?.clickhouse?.read_bytes_per_second)}/s`,
          ],
          [
            "Disk write / second",
            `${formatBytes(m?.clickhouse?.written_bytes_per_second)}/s`,
          ],
          ["Server", capabilities?.source || "Unavailable"],
          ["Version", capabilities?.server_version || "Unavailable"],
        ].map(([title, value]) => (
          <div className="card p-5" key={title}>
            <p className="text-xs text-muted-foreground">{title}</p>
            <p className="text-xl mt-3 mono break-all">{value}</p>
          </div>
        ))}
      </div>
      <Panel
        title="Server history"
        action={
          <div className="flex gap-2">
            <SelectControl
              label="Metric"
              value={series}
              onValueChange={setSeries}
              options={[
                { value: "queries_per_second", label: "Queries / second" },
                { value: "active_queries", label: "Active queries" },
                { value: "memory_bytes", label: "Memory" },
                {
                  value: "read_bytes_per_second",
                  label: "Disk reads / second",
                },
                {
                  value: "written_bytes_per_second",
                  label: "Disk writes / second",
                },
              ]}
            />
            <SelectControl
              label="Time range"
              value={range}
              onValueChange={setRange}
              options={[
                { value: "1800000", label: "30 minutes" },
                { value: "21600000", label: "6 hours" },
                { value: "86400000", label: "24 hours" },
                { value: "604800000", label: "7 days" },
              ]}
            />
          </div>
        }
      >
        {data.some((r) => r.value != null) ? (
          <div className="h-64 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(t) => new Date(t).toLocaleTimeString()}
                />
                <YAxis
                  tickFormatter={(v) =>
                    series.includes("bytes") ? formatBytes(v) : formatNumber(v)
                  }
                />
                <Tooltip
                  labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                  formatter={(v) =>
                    series.includes("bytes")
                      ? formatBytes(Number(v))
                      : formatNumber(Number(v))
                  }
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="var(--primary)"
                  fill="var(--primary)"
                  fillOpacity={0.15}
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <Empty
            title="Waiting for metrics"
            description="Rate charts need two successful samples. Missing permissions and outages appear as gaps."
          />
        )}
      </Panel>
      {capabilities && (
        <Panel title="Available features">
          <Grid
            rows={Object.entries(capabilities.features)}
            columns={[
              { label: "Feature", render: (r) => r[0] },
              {
                label: "Status",
                render: (r) =>
                  r[1].available ? "Available" : r[1].reason || "Unavailable",
              },
            ]}
          />
        </Panel>
      )}
    </>
  );
}
function Catalog({ id }: { id: string }) {
  const databases = useCH<CH<"DatabaseRow">[]>(id, "databases");
  const [chosenDb, setDb] = useState("");
  const [table, setTable] = useState("");
  const db = chosenDb || databases.data?.[0]?.name || "";
  const tables = useCH<CH<"TableRow">[]>(
    id,
    `tables?database=${encodeURIComponent(db)}`,
    undefined,
    !!db,
  );
  const columns = useCH<CH<"ColumnRow">[]>(
    id,
    `columns?database=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`,
    undefined,
    !!db && !!table,
  );
  return (
    <>
      <ErrorBox error={databases.error} />
      <Panel
        title="Tables and views"
        action={
          <SelectControl
            label="Database"
            value={db}
            onValueChange={(v) => {
              setDb(v);
              setTable("");
            }}
            options={(databases.data || []).map((r) => ({
              value: r.name,
              label: `${r.name} · ${r.engine}`,
            }))}
          />
        }
      >
        {db ? (
          <Result query={tables}>
            {(rows) => (
              <Grid
                rows={rows}
                columns={[
                  {
                    label: "Name",
                    render: (r) => (
                      <button
                        className="text-primary"
                        onClick={() => setTable(r.name)}
                      >
                        {r.name}
                      </button>
                    ),
                  },
                  { label: "Engine", render: (r) => r.engine },
                  {
                    label: "Rows (metadata)",
                    render: (r) => r.total_rows ?? "Unavailable",
                  },
                  {
                    label: "Storage",
                    render: (r) =>
                      r.total_bytes == null
                        ? "Unavailable"
                        : formatBytes(Number(r.total_bytes)),
                  },
                  {
                    label: "Sorting / partition keys",
                    render: (r) =>
                      `${r.sorting_key || "—"} / ${r.partition_key || "—"}`,
                  },
                ]}
              />
            )}
          </Result>
        ) : (
          <Empty
            title="No databases"
            description="The connected account cannot see any database metadata."
          />
        )}
      </Panel>
      {table && (
        <Panel title={`Columns · ${db}.${table}`}>
          <Result query={columns}>
            {(rows) => (
              <Grid
                rows={rows}
                columns={[
                  { label: "Column", render: (r) => r.name },
                  { label: "Type", render: (r) => r.type },
                  {
                    label: "Default",
                    render: (r) => `${r.default_kind} ${r.default_expression}`,
                  },
                ]}
              />
            )}
          </Result>
        </Panel>
      )}
    </>
  );
}
function Queries({
  id,
  capabilities,
  notify,
}: {
  id: string;
  capabilities?: CH<"Capabilities">;
  notify: (s: string) => void;
}) {
  const queries = useCH<CH<"QueryRow">[]>(id, "queries", 5000);
  const [target, setTarget] = useState<CH<"QueryRow">>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Panel title="Active queries">
        <Result query={queries}>
          {(rows) => (
            <Grid
              rows={rows}
              rowKey={(r) => r.query_id}
              columns={[
                {
                  label: "Query",
                  render: (r) => (
                    <>
                      <p className="mono text-xs">{r.query_id}</p>
                      <pre className="max-w-lg whitespace-pre-wrap text-xs">
                        {r.query}
                      </pre>
                    </>
                  ),
                },
                { label: "User", render: (r) => r.user },
                {
                  label: "Elapsed",
                  render: (r) => `${formatNumber(r.elapsed)} s`,
                },
                {
                  label: "Memory",
                  render: (r) => formatBytes(Number(r.memory_usage)),
                },
                {
                  label: "Action",
                  render: (r) => (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={
                        !r.kill_token || !capabilities?.features.kill?.available
                      }
                      onClick={() => {
                        setError("");
                        setTarget(r);
                      }}
                    >
                      Cancel query
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Result>
      </Panel>
      <Dialog
        open={!!target}
        onOpenChange={(open) => !busy && !open && setTarget(undefined)}
        title="Cancel this query?"
        description={`Cancel ${target?.query_id || ""} on the connected server. References expire after 30 seconds.`}
      >
        <ErrorBox error={error} />
        <div className="form-footer">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setTarget(undefined)}
          >
            Keep running
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await chApi(id, "queries/kill", "POST", {
                  token: target?.kill_token,
                });
                setTarget(undefined);
                notify("Query cancellation completed");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
                void queries.refetch();
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
function History({ id }: { id: string }) {
  const history = useCH<CH<"HistoryRow">[]>(id, "history", 15000);
  return (
    <Panel title="Recent SELECT queries · last 24 hours · up to 100">
      <p className="p-4 text-xs text-muted-foreground">
        Query text stays in ClickHouse. Availability depends on query logging
        and permissions; records may arrive after a delay.
      </p>
      <Result query={history}>
        {(rows) => (
          <Grid
            rows={rows}
            columns={[
              { label: "Time", render: (r) => r.event_time },
              { label: "User", render: (r) => r.user },
              {
                label: "Query",
                render: (r) => (
                  <pre className="whitespace-pre-wrap text-xs max-w-lg">
                    {r.query}
                  </pre>
                ),
              },
              { label: "Duration", render: (r) => `${r.query_duration_ms} ms` },
              { label: "Read rows", render: (r) => r.read_rows },
              { label: "Error code", render: (r) => r.exception_code || "—" },
            ]}
          />
        )}
      </Result>
    </Panel>
  );
}
function Replicas({ id }: { id: string }) {
  const replicas = useCH<CH<"ReplicaRow">[]>(id, "replicas", 15000);
  return (
    <Panel title="Replication on the connected server">
      <Result query={replicas}>
        {(rows) => (
          <Grid
            rows={rows}
            columns={[
              { label: "Table", render: (r) => `${r.database}.${r.table}` },
              { label: "Replica", render: (r) => r.replica_name },
              {
                label: "Status",
                render: (r) => (r.is_readonly ? "Read-only" : "Writable"),
              },
              { label: "Queue", render: (r) => r.queue_size },
              { label: "Delay", render: (r) => `${r.absolute_delay} s` },
            ]}
          />
        )}
      </Result>
    </Panel>
  );
}
