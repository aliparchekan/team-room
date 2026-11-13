// Small UI pieces shared by rooms and AutoResearch.
import { useState, type ReactNode } from "react";
import { api } from "./api";
import { PERMISSION_DESCRIPTIONS, PERMISSION_LABELS, PERMISSION_MODES, thinkingOption } from "../../shared/types";
import type { PermissionMode, ProviderInfo, T3Status } from "../../shared/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const ICONS = {
  plus: "M12 5v14M5 12h14",
  chevron: "M9 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
};

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const INITIALS: Record<string, string> = { claude: "Cl", codex: "Cx", human: "You" };

/**
 * `who`: the author's handle ("claude", "grok2", "human"). `tone`: the colour family (the provider), when it differs
 * from the handle. Initials come from the handle, keeping a trailing number: "claude2" → "Cl2".
 */
export function Avatar({ who, name, tone }: { who: string; name?: string; tone?: string }) {
  const n = /\d+$/.exec(who)?.[0] ?? "";
  const base = who.slice(0, who.length - n.length);
  const initials = (INITIALS[base] ?? (name ?? base).replace(/[^A-Za-z]/g, "").slice(0, 2).replace(/^./, (c) => c.toUpperCase())) + n;
  return (
    <span className={`avatar a-${tone ?? who}`} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

export function Md({ text }: { text: string }) {
  return (
    <div className="md">
      {/* Links open in a new tab: Team Room's app window has no back button, so following one in place strands you. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A link to a T3 thread that opens it in the T3 desktop app. Falls back to T3's web page if the app
 * can't be opened (other OS, or the server refuses). Keeps the web URL as href for copy-link.
 */
export function T3Link({ link, className, title, children }: { link: string | null | undefined; className?: string; title?: string; children: ReactNode }) {
  if (!link) return null;
  return (
    <a
      className={className}
      href={link}
      title={title ?? "Open in the T3 app"}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let modified clicks behave like normal links
        e.preventDefault();
        api.openInT3(link).catch(() => window.open(link, "_blank", "noreferrer"));
      }}
    >
      {children}
    </a>
  );
}

export type Waiting = { id: string; name: string; link: string | null; threadId: string | null };

export function T3ApprovalPanel({ item, webOrigin, resolved, onClose }: { item: Waiting; webOrigin: string; resolved: boolean; onClose: () => void }) {
  // Thread links look like https://app.t3.codes/threads/<environmentId>/<threadId>.
  const path = item.link ? new URL(item.link).pathname.replace(/^\/threads\//, "/") : null;
  const src = path ? `${webOrigin}${path}` : null;
  const [frameKey, setFrameKey] = useState(0);
  return (
    <div className="modal-backdrop" role="dialog" aria-label={`T3 approval for ${item.name}`}>
      <div className="t3-panel">
        <div className="t3-panel-head">
          <div>
            <b>{item.name}</b> · T3 thread
            <div className="muted small">
              {resolved
                ? "T3 no longer shows a pending request. The agent is continuing."
                : "Approve or deny in T3's own screen below. First time only: T3 asks to pair this browser. Paste a token from T3 Settings → Sharing & access, or from t3 auth pairing create, then click Reload."}
            </div>
          </div>
          <span className="spacer" />
          <button onClick={() => setFrameKey((k) => k + 1)}>Reload</button>
          {item.link && (
            <T3Link className="button" link={item.link}>
              Open in T3 app <Icon name="external" />
            </T3Link>
          )}
          <button className={resolved ? "primary" : ""} onClick={onClose}>
            {resolved ? "Done" : "Close"}
          </button>
        </div>
        {src ? <iframe key={frameKey} className="t3-frame" src={src} title={`T3 thread for ${item.name}`} /> : <p className="muted">No T3 link for this thread yet.</p>}
      </div>
    </div>
  );
}


/**
 * Raise Team Room's access in T3. T3 sets the ceiling when Team Room is approved, so this signs Team Room out and
 * opens T3's approval page, where the human picks the level (Full access, for no approval prompts).
 */
export async function grantMoreAccess(): Promise<T3Status | null> {
  if (
    !confirm(
      "Change Team Room's access level in T3?\n\nTeam Room signs out of T3 now and opens T3's approval page. Choose the level there (Full access for no approval prompts) and enter a pairing code from T3 Settings → Sharing & access. Until you approve, Team Room cannot reach your agents; your rooms are kept.",
    )
  )
    return null;
  const s = await api.reauthorize();
  if (s.connection.kind === "needs_auth" && s.connection.authorizationUrl) window.open(s.connection.authorizationUrl, "_blank", "noreferrer");
  return s;
}

/** The T3 permission picker used everywhere a mode is chosen: T3's own descriptions, the access ceiling, a way up. */
export function PermissionSelect({ value, onChange, cap, id }: { value: PermissionMode; onChange: (m: PermissionMode) => void; cap: PermissionMode | null; id?: string }) {
  const allowed = (m: PermissionMode) => !cap || PERMISSION_MODES.indexOf(m) <= PERMISSION_MODES.indexOf(cap);
  return (
    <>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as PermissionMode)}>
        {PERMISSION_MODES.map((m) => (
          <option key={m} value={m} disabled={!allowed(m)}>
            {PERMISSION_LABELS[m]} — {PERMISSION_DESCRIPTIONS[m]}
            {allowed(m) ? "" : " (needs more access)"}
          </option>
        ))}
      </select>
      {value === "full-access" && (
        <span className="warn small perm-note">Agents run commands and edit files without asking you. They still stop for a few safety checks of their own that no setting skips.</span>
      )}
      {cap && cap !== "full-access" && (
        <span className="muted small perm-note">
          Team Room may use up to {PERMISSION_LABELS[cap]}.{" "}
          <button type="button" className="link small" onClick={() => grantMoreAccess().catch((e) => alert(e.message))}>
            Grant more access…
          </button>
        </span>
      )}
    </>
  );
}

const cap1 = (v: string | boolean) => (typeof v === "string" ? v.charAt(0).toUpperCase() + v.slice(1) : String(v));

/**
 * How much the model thinks: Claude's `effort`, Codex's `reasoningEffort`, with the values T3 lists for that model.
 * Renders nothing for models without such a setting.
 */
export function ThinkingSelect({
  providers,
  providerInstanceId,
  model,
  options,
  onChange,
  compact,
}: {
  providers: ProviderInfo[];
  providerInstanceId: string;
  model: string;
  options: Record<string, string | boolean>;
  onChange: (options: Record<string, string | boolean>) => void;
  compact?: boolean;
}) {
  const opt = thinkingOption(providers, providerInstanceId, model);
  if (!opt) return null;
  const value = options[opt.id];
  const select = (
    <select
      value={value === undefined ? "" : String(value)}
      aria-label="Thinking level"
      onChange={(e) => {
        const next = { ...options };
        if (e.target.value === "") delete next[opt.id];
        else next[opt.id] = opt.values.find((v) => String(v) === e.target.value) ?? e.target.value;
        onChange(next);
      }}
    >
      <option value="">Default{opt.default != null ? ` (${cap1(opt.default)})` : ""}</option>
      {opt.values.map((v) => (
        <option key={String(v)} value={String(v)}>
          {cap1(v)}
        </option>
      ))}
    </select>
  );
  if (compact) return <span className="thinking-inline">Thinking {select}</span>;
  return (
    <label className="stack small thinking">
      Thinking level
      {select}
      <span className="muted small">Higher levels think longer and use more of your plan's usage.</span>
    </label>
  );
}
