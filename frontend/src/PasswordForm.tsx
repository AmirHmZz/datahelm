import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, type Session } from "./api";
import { Button } from "./components/ui/button";

export default function PasswordForm({
  firstLogin = false,
  onChanged,
  onCancel,
}: {
  firstLogin?: boolean;
  onChanged: (session: Session) => void;
  onCancel?: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="password-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (password !== confirmation) {
          setError("New passwords do not match.");
          return;
        }
        setBusy(true);
        try {
          const session = await api<Session>("/auth/password", "POST", {
            current_password: current,
            new_password: password,
          });
          setCurrent("");
          setPassword("");
          setConfirmation("");
          onChanged(session);
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {firstLogin ? "Temporary password" : "Current password"}
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          maxLength={1024}
          required
        />
      </label>
      <label>
        New password
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={12}
          maxLength={1024}
          aria-describedby="password-guidance"
          required
        />
      </label>
      <p id="password-guidance" className="text-xs text-muted-foreground">
        Use at least 12 characters. Other sessions will be signed out.
      </p>
      <label>
        Confirm new password
        <input
          type="password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="new-password"
          minLength={12}
          maxLength={1024}
          required
        />
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy
            ? "Saving…"
            : firstLogin
              ? "Set password and continue"
              : "Change password"}
        </Button>
      </div>
    </form>
  );
}
