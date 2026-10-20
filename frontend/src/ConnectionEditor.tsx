import { useState } from "react";
import {
  ShieldCheck,
  KeyRound,
  Server,
  FlaskConical,
  Loader2,
} from "lucide-react";
import { api, type Connection, type ConnectionConfig } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { SelectControl } from "./components/ui/select";
export const blankConfig = (): ConnectionConfig => ({
  name: "",
  engine: "mongodb",
  clickhouse: null,
  mode: "form",
  hosts: "localhost:27017",
  username: "",
  password: null,
  uri: null,
  auth_database: "admin",
  mechanism: "",
  replica_set: "",
  direct: false,
  monitoring: true,
  tls: {
    enabled: false,
    allow_invalid_certificates: false,
    ca_pem: null,
    client_pem: null,
    key_password: null,
  },
  ssh: {
    enabled: false,
    host: "",
    port: 22,
    username: "",
    password: null,
    private_key: null,
    passphrase: null,
    fingerprint: null,
  },
});
export default function ConnectionEditor({
  connection,
  onClose,
  onSaved,
}: {
  connection?: Connection;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [config, setConfig] = useState<ConnectionConfig>(() =>
    connection ? { ...connection.config, uri: null } : blankConfig(),
  );
  const clickhouse = config.engine === "clickhouse";
  const changeCH = (key: string, value: unknown) =>
    change("clickhouse", { ...config.clickhouse, [key]: value });
  const [section, setSection] = useState("general");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [test, setTest] = useState<any>();
  const [discovered, setDiscovered] = useState("");
  const change = (key: keyof ConnectionConfig, value: unknown) => {
    setConfig((c) => ({ ...c, [key]: value }));
    setTest(undefined);
  };
  const tls = (key: string, value: unknown) => {
    setConfig((c) => ({ ...c, tls: { ...c.tls, [key]: value } }));
    setTest(undefined);
  };
  const ssh = (key: string, value: unknown) => {
    setConfig((c) => ({
      ...c,
      ssh: {
        ...c.ssh,
        [key]: value,
        ...(["host", "port"].includes(key) ? { fingerprint: null } : {}),
      },
    }));
    setDiscovered("");
    setTest(undefined);
  };
  async function upload(
    file: File | undefined,
    key: string,
    kind: "tls" | "ssh",
  ) {
    if (!file) return;
    if (file.size > 200000) {
      setError("Certificate and key files must be smaller than 200 KB");
      return;
    }
    const text = await file.text();
    kind === "tls" ? tls(key, text) : ssh(key, text);
  }
  async function runTest() {
    setBusy(true);
    setError("");
    setTest(undefined);
    try {
      setTest(
        await api("/connections/test", "POST", {
          config,
          saved_id: connection?.id,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        connection ? `/connections/${connection.id}` : "/connections",
        connection ? "PUT" : "POST",
        config,
      );
      onSaved(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function fingerprint() {
    setBusy(true);
    setError("");
    try {
      const r = await api("/connections/ssh-fingerprint", "POST", { config });
      setDiscovered(r.fingerprint);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={connection ? "Edit connection" : "Add a connection"}
      description="Keep your MongoDB and ClickHouse instances within reach. Credentials are encrypted at rest."
      wide
    >
      <div className="tabs">
        {[
          ["general", Server, "Connection"],
          ["tls", ShieldCheck, "TLS / SSL"],
          ["ssh", KeyRound, "SSH tunnel"],
        ].map(([key, Icon, label]) => {
          const I = Icon as typeof Server;
          return (
            <button
              className={`tab ${section === key ? "active" : ""}`}
              key={key as string}
              onClick={() => setSection(key as string)}
            >
              <I size={14} />
              {label as string}
            </button>
          );
        })}
      </div>
      {section === "general" && (
        <div>
          <label>
            Connection name
            <input
              value={config.name}
              onChange={(e) => change("name", e.target.value)}
              placeholder="Production cluster"
              autoFocus
            />
          </label>
          <label className="mt-4">
            Database engine
            <SelectControl
              label="Database engine"
              value={config.engine || "mongodb"}
              disabled={!!connection}
              options={[
                { value: "mongodb", label: "MongoDB" },
                { value: "clickhouse", label: "ClickHouse" },
              ]}
              onValueChange={(value) => {
                setTest(undefined);
                setConfig((c) => ({
                  ...c,
                  engine: value as "mongodb" | "clickhouse",
                  tls: {
                    ...c.tls,
                    enabled: false,
                    client_pem: null,
                    key_password: null,
                  },
                  clickhouse:
                    value === "clickhouse"
                      ? {
                          endpoint: "http://localhost:8123",
                          database: "default",
                          username: "default",
                          password: null,
                        }
                      : null,
                }));
              }}
            />
          </label>
          {clickhouse ? (
            <>
              <div className="notice">
                ClickHouse 26.8+ · Changes target the connected server without
                ON CLUSTER.
              </div>
              <label>
                HTTP(S) endpoint
                <input
                  value={config.clickhouse?.endpoint || ""}
                  placeholder="https://clickhouse.example.com:8443"
                  onChange={(e) => {
                    const endpoint = e.target.value;
                    setConfig((c) => ({
                      ...c,
                      clickhouse: { ...c.clickhouse!, endpoint },
                      tls: {
                        ...c.tls,
                        enabled: endpoint.startsWith("https://"),
                      },
                    }));
                    setTest(undefined);
                  }}
                />
              </label>
              <div className="form-grid mt-4">
                <label>
                  Database
                  <input
                    value={config.clickhouse?.database || ""}
                    onChange={(e) => changeCH("database", e.target.value)}
                  />
                </label>
                <label>
                  Username
                  <input
                    autoComplete="off"
                    value={config.clickhouse?.username || ""}
                    onChange={(e) => changeCH("username", e.target.value)}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={config.clickhouse?.password || ""}
                    placeholder={
                      connection?.has_password
                        ? "Saved · leave blank to preserve"
                        : ""
                    }
                    onChange={(e) =>
                      changeCH("password", e.target.value || null)
                    }
                  />
                </label>
              </div>
              {connection?.has_password && (
                <Button
                  variant="outline"
                  className="mt-3"
                  onClick={() => changeCH("password", "")}
                >
                  Remove saved database password
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="form-grid mt-4">
                <label>
                  Connection method
                  <SelectControl
                    label="Connection method"
                    value={config.mode ?? "form"}
                    onValueChange={(value) => change("mode", value)}
                    options={[
                      { value: "form", label: "Host / port / authentication" },
                      { value: "uri", label: "Connection URI" },
                    ]}
                  />
                </label>
                <label>
                  Authentication mechanism
                  <SelectControl
                    label="Authentication mechanism"
                    value={config.mechanism ?? ""}
                    onValueChange={(value) => change("mechanism", value)}
                    disabled={config.mode === "uri"}
                    options={[
                      { value: "", label: "Auto / SCRAM" },
                      ...["SCRAM-SHA-256", "SCRAM-SHA-1", "MONGODB-X509"].map(
                        (value) => ({ value, label: value }),
                      ),
                    ]}
                  />
                </label>
              </div>
              {config.mode === "uri" ? (
                <label className="mt-4">
                  MongoDB URI
                  <textarea
                    value={config.uri || ""}
                    onChange={(e) => change("uri", e.target.value || null)}
                    placeholder={
                      connection?.has_uri
                        ? "Leave blank to preserve the saved URI"
                        : "mongodb://user:password@host:27017/?authSource=admin"
                    }
                    autoComplete="off"
                  />
                  <span className="text-xs">
                    Supports mongodb:// and self-managed mongodb+srv:// records.
                  </span>
                </label>
              ) : (
                <>
                  <label className="mt-4">
                    Hosts and ports
                    <input
                      value={config.hosts}
                      onChange={(e) => change("hosts", e.target.value)}
                      placeholder="mongo-1:27017,mongo-2:27017,mongo-3:27017"
                      className="mono"
                    />
                  </label>
                  <div className="form-grid mt-4">
                    <label>
                      Username
                      <input
                        value={config.username}
                        onChange={(e) => change("username", e.target.value)}
                        placeholder={
                          config.mechanism === "MONGODB-X509"
                            ? "Optional · certificate subject"
                            : ""
                        }
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Password
                      <input
                        type="password"
                        disabled={config.mechanism === "MONGODB-X509"}
                        value={config.password || ""}
                        onChange={(e) =>
                          change("password", e.target.value || null)
                        }
                        placeholder={
                          connection?.has_password
                            ? "Saved • leave blank to preserve"
                            : ""
                        }
                        autoComplete="new-password"
                      />
                    </label>
                    <label>
                      Authentication database
                      <input
                        value={config.auth_database}
                        onChange={(e) =>
                          change("auth_database", e.target.value)
                        }
                      />
                    </label>
                    <label>
                      Replica set name
                      <input
                        value={config.replica_set}
                        onChange={(e) => change("replica_set", e.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                  </div>
                  {connection?.has_password && (
                    <Button
                      className="mt-3"
                      variant="outline"
                      size="sm"
                      onClick={() => change("password", "")}
                    >
                      Remove saved database password
                    </Button>
                  )}
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={config.direct}
                      onChange={(e) => change("direct", e.target.checked)}
                    />
                    Connect directly to one node
                  </label>
                </>
              )}
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={config.monitoring}
              onChange={(e) => change("monitoring", e.target.checked)}
            />
            Collect server metrics every five seconds
          </label>
          <p className="text-xs text-muted-foreground mt-3">
            Monitoring continues while the dashboard is closed. History is
            retained for seven days.
          </p>
        </div>
      )}
      {section === "tls" && (
        <div>
          <label className="check">
            <input
              type="checkbox"
              checked={config.tls.enabled}
              onChange={(e) => {
                tls("enabled", e.target.checked);
                if (clickhouse)
                  changeCH(
                    "endpoint",
                    (config.clickhouse?.endpoint || "").replace(
                      /^https?:/,
                      e.target.checked ? "https:" : "http:",
                    ),
                  );
              }}
            />
            Enable TLS encryption
          </label>
          <div className="notice">
            Certificates are verified by default. Uploaded private material is
            encrypted in storage and loaded only into a memory-backed runtime
            directory.
          </div>
          <div className="form-grid">
            <label>
              Custom CA certificate
              <input
                type="file"
                accept=".pem,.crt,.cer"
                onChange={(e) =>
                  void upload(e.target.files?.[0], "ca_pem", "tls")
                }
              />
              {connection?.has_ca && (
                <span className="text-primary text-xs">Saved certificate</span>
              )}
            </label>
            {!clickhouse && (
              <>
                <label>
                  Client certificate and private key (PEM)
                  <input
                    type="file"
                    accept=".pem"
                    onChange={(e) =>
                      void upload(e.target.files?.[0], "client_pem", "tls")
                    }
                  />
                  {connection?.has_client_certificate && (
                    <span className="text-primary text-xs">
                      Saved client certificate
                    </span>
                  )}
                </label>
                <label>
                  Client key password
                  <input
                    type="password"
                    value={config.tls.key_password || ""}
                    onChange={(e) =>
                      tls("key_password", e.target.value || null)
                    }
                    autoComplete="new-password"
                  />
                </label>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            {connection?.has_ca && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => tls("ca_pem", "")}
              >
                Remove saved CA
              </Button>
            )}
            {connection?.has_client_certificate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  tls("client_pem", "");
                  tls("key_password", "");
                }}
              >
                Remove saved client certificate
              </Button>
            )}
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={config.tls.allow_invalid_certificates}
              onChange={(e) =>
                tls("allow_invalid_certificates", e.target.checked)
              }
            />
            Allow invalid certificates (development only)
          </label>
          {config.tls.allow_invalid_certificates && (
            <div className="error mt-3">
              Certificate verification is disabled for this connection.
            </div>
          )}
        </div>
      )}
      {section === "ssh" && (
        <div>
          <label className="check mb-5">
            <input
              type="checkbox"
              checked={config.ssh.enabled}
              onChange={(e) => ssh("enabled", e.target.checked)}
            />
            Connect through an SSH tunnel
          </label>
          <div className="form-grid">
            <label>
              SSH host
              <input
                value={config.ssh.host}
                onChange={(e) => ssh("host", e.target.value)}
              />
            </label>
            <label>
              SSH port
              <input
                type="number"
                value={config.ssh.port || 22}
                onChange={(e) => ssh("port", Number(e.target.value))}
              />
            </label>
            <label>
              SSH username
              <input
                value={config.ssh.username}
                onChange={(e) => ssh("username", e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              SSH password
              <input
                type="password"
                value={config.ssh.password || ""}
                onChange={(e) => ssh("password", e.target.value || null)}
                placeholder={
                  connection?.has_ssh_password
                    ? "Saved • leave blank to preserve"
                    : ""
                }
                autoComplete="new-password"
              />
            </label>
            <label>
              Private key
              <input
                type="file"
                accept=".pem,.key,*"
                onChange={(e) =>
                  void upload(e.target.files?.[0], "private_key", "ssh")
                }
              />
              {connection?.has_ssh_key && (
                <span className="text-primary text-xs">Saved key</span>
              )}
            </label>
            <label>
              Key passphrase
              <input
                type="password"
                value={config.ssh.passphrase || ""}
                onChange={(e) => ssh("passphrase", e.target.value || null)}
                autoComplete="new-password"
              />
            </label>
          </div>
          {connection?.has_ssh_password && (
            <Button
              className="mt-4 mr-2"
              variant="outline"
              size="sm"
              onClick={() => ssh("password", "")}
            >
              Remove saved SSH password
            </Button>
          )}
          {connection?.has_ssh_key && (
            <Button
              className="mt-4"
              variant="outline"
              size="sm"
              onClick={() => {
                ssh("private_key", "");
                ssh("passphrase", "");
              }}
            >
              Remove saved SSH key
            </Button>
          )}
          <div className="form-section">
            <div className="form-section-title">
              <ShieldCheck size={15} />
              SSH host verification
            </div>
            {config.ssh.fingerprint ? (
              <div className="notice">
                <span className="text-primary">Trusted host</span>
                <p className="mono text-xs mt-2 break-all">
                  {config.ssh.fingerprint}
                </p>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() => void fingerprint()}
                disabled={busy || !config.ssh.host}
              >
                Fetch host fingerprint
              </Button>
            )}
            {discovered && !config.ssh.fingerprint && (
              <div className="notice">
                <p>
                  Verify this fingerprint with your server administrator before
                  trusting it.
                </p>
                <p className="mono text-xs my-3 break-all">{discovered}</p>
                <Button
                  size="sm"
                  onClick={() => ssh("fingerprint", discovered)}
                >
                  Trust this fingerprint
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      {error && <div className="error mt-5">{error}</div>}
      {test && (
        <div className="notice text-primary">
          Connection successful · {test.latency_ms} ms ·{" "}
          {test.topology.replace("_", " ")}
        </div>
      )}
      <div className="form-footer">
        <Button
          variant="outline"
          onClick={() => void runTest()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <FlaskConical size={14} />
          )}
          Test connection
        </Button>
        <Button onClick={() => void save()} disabled={busy || !config.name}>
          {connection ? "Save changes" : "Save connection"}
        </Button>
      </div>
    </Dialog>
  );
}
