"use client";

import { Check, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Field, Input, Select, Switch, Tabs, type TabItem } from "@/components/ui";
import type { Backend } from "@/features/backends/server/schema";
import { formatKnownUserLabel } from "@/features/known-users/format";
import type { KnownUser } from "@/features/known-users/server/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";
import type { Settings } from "../server/schema";
import { readError, useBackendModels, useProbe, useSecretField } from "./connection";
import { ChangePasswordSection } from "./ChangePasswordSection";
import { RoleSection } from "./RoleSection";

/**
 * Bot settings editor. Client Component with one tab per concern. The LLM
 * configuration is per **role** — Chat (the main model every reply runs on,
 * which must support thinking and tool calls), Embeddings, Images, Speech,
 * Audio (STT), Vision, and Browser agent — and every role picks a backend from
 * the shared catalog (managed on the Backends page) plus a model through a
 * searchable select fed by that backend's live model list. A role without its
 * own backend uses the chat backend; audio/vision/browser additionally fall
 * back to the chat model when none is picked ("main by default").
 *
 * One Save button below the tabs persists every changed field regardless of
 * the active tab. Secrets are write-only — shown as "configured" but their
 * values never leave the server.
 *
 * Only changed fields are sent, which the server relies on: a model absent
 * from the patch is a *stored* selection, and when the same patch repoints the
 * backend serving it, the server verifies it against the new backend's model
 * list and clears it if it is not served. The form covers the case that check
 * cannot see — a selection stale against the *unchanged* backend: a
 * successfully listed backend that does not serve the stored model flags it on
 * its tab, and the save sends it as null. Either way, everything cleared is
 * named next to the Save button.
 */

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** One role's backend + model selection state. */
function useRoleConfig(initial: { backendId: string | null; model: string | null }) {
  const [backendId, setBackendId] = useState(initial.backendId);
  const [model, setModel] = useState(initial.model ?? "");
  return {
    backendId,
    model,
    setBackendId,
    setModel,
    applySaved(saved: { backendId: string | null; model: string | null }) {
      setBackendId(saved.backendId);
      setModel(saved.model ?? "");
    },
  };
}

type RoleConfig = ReturnType<typeof useRoleConfig>;

export function SettingsForm({
  initial,
  backends = [],
  initialBackendModels = {},
  knownUsers = [],
}: {
  initial: Settings;
  /** The saved backend catalog the role selects offer. */
  backends?: Backend[];
  /** Models preloaded server-side per backend id, so dropdowns work on open. */
  initialBackendModels?: Record<string, string[]>;
  /** Users who have messaged the bot — the owner is chosen from this list. */
  knownUsers?: KnownUser[];
}) {
  const router = useRouter();

  // Role configurations.
  const chat = useRoleConfig({ backendId: initial.chatBackendId, model: initial.model });
  const emb = useRoleConfig({
    backendId: initial.embeddingBackendId,
    model: initial.embeddingModel,
  });
  const img = useRoleConfig({ backendId: initial.imageBackendId, model: initial.imageModel });
  const spc = useRoleConfig({ backendId: initial.speechBackendId, model: initial.speechModel });
  const aud = useRoleConfig({ backendId: initial.audioBackendId, model: initial.audioModel });
  const vis = useRoleConfig({ backendId: initial.visionBackendId, model: initial.visionModel });
  const brw = useRoleConfig({ backendId: initial.browserBackendId, model: initial.browserModel });
  const [speechVoice, setSpeechVoice] = useState(initial.speechVoice ?? "");
  const [audioTranscriptionMode, setAudioTranscriptionMode] = useState(
    initial.audioTranscriptionMode,
  );

  // Core operational settings.
  const botToken = useSecretField(initial.telegramBotTokenConfigured);
  const tavilyKey = useSecretField(initial.webSearchConfigured);
  const [ownerUserId, setOwnerUserId] = useState(initial.ownerUserId ?? "");
  const [maintenanceMode, setMaintenanceMode] = useState(initial.maintenanceModeEnabled);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [dailyJobsRunTime, setDailyJobsRunTime] = useState(initial.dailyJobsRunTime);
  const [browserDownloadLimitGb, setBrowserDownloadLimitGb] = useState(
    String(initial.browserDownloadLimitGb),
  );

  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // Model selections cleared on the last save (client-flagged stale plus
  // whatever the server cleared after a repoint) — shown next to the Save
  // button, since the roles they belong to live on other tabs.
  const [clearedOnSave, setClearedOnSave] = useState<string[]>([]);
  // Controlled so the global Save row can step aside on the Security tab, whose
  // password change has its own endpoint and button.
  const [activeTab, setActiveTab] = useState("chat");

  // Per-backend model lists, preloaded for saved backends and fetched on
  // demand for any backend a role gets pointed at afterwards.
  const modelCache = useBackendModels(initialBackendModels);

  /** The backend a role actually talks to: its own, else the chat one. */
  const effectiveBackendId = (role: RoleConfig) => role.backendId ?? chat.backendId;

  const roleList = [chat, emb, img, spc, aud, vis, brw];
  const effectiveIds = roleList.map(effectiveBackendId);
  useEffect(() => {
    for (const id of effectiveIds) modelCache.ensure(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveIds.join("|")]);

  // Probes.
  const chatProbe = useProbe<{ models: string[] }>("/api/backends/test");
  const embedProbe = useProbe<{ model: string; dimensions: number }>(
    "/api/settings/test-embeddings",
  );
  const imageProbe = useProbe<{ model: string; modelCount: number }>("/api/settings/test-images");
  const speechProbe = useProbe<{ model: string; modelCount: number }>("/api/settings/test-speech");
  const audioProbe = useProbe<{ model: string; text: string }>("/api/settings/test-audio");
  const visionProbe = useProbe<{ model: string; description: string }>(
    "/api/settings/test-vision",
  );

  async function onTestChat() {
    if (!chat.backendId) return;
    const data = await chatProbe.run({ backendId: chat.backendId });
    if (data) modelCache.prime(chat.backendId, data.models);
  }

  /** Probe body for one role: the form's current (possibly unsaved) values. */
  const roleProbeBody = (role: RoleConfig) => ({
    backendId: role.backendId,
    model: role.model.trim() === "" ? null : role.model.trim(),
  });

  /** The model-list state a role's combobox renders from. */
  const roleModels = (role: RoleConfig) => modelCache.get(effectiveBackendId(role));

  /**
   * Whether a role's selection is provably stale: its effective backend's list
   * was successfully fetched and does not contain the stored model. Free-text
   * roles (audio) are exempt — an absent listing proves nothing there.
   */
  const roleStale = (role: RoleConfig) => {
    const models = roleModels(role);
    return (
      models?.kind === "ok" && role.model.trim() !== "" && !models.models.includes(role.model.trim())
    );
  };

  const staleWarning = (m: string) =>
    `"${m}" is not served by the configured backend — it will be cleared on save unless you pick another.`;

  async function onSave() {
    setSave({ kind: "saving" });
    setClearedOnSave([]);

    // Changed fields only. The server depends on that: a model missing from the
    // patch is a stored selection, which it verifies (and clears) when the same
    // patch repoints the backend serving it.
    const patch: Record<string, unknown> = {};
    const roleFields = [
      { role: chat, backendKey: "chatBackendId", modelKey: "model", label: "chat model", listed: true },
      {
        role: emb,
        backendKey: "embeddingBackendId",
        modelKey: "embeddingModel",
        label: "embedding model",
        listed: true,
      },
      { role: img, backendKey: "imageBackendId", modelKey: "imageModel", label: "image model", listed: true },
      { role: spc, backendKey: "speechBackendId", modelKey: "speechModel", label: "speech model", listed: true },
      { role: aud, backendKey: "audioBackendId", modelKey: "audioModel", label: "audio model", listed: false },
      { role: vis, backendKey: "visionBackendId", modelKey: "visionModel", label: "vision model", listed: true },
      {
        role: brw,
        backendKey: "browserBackendId",
        modelKey: "browserModel",
        label: "browser model",
        listed: true,
      },
    ] as const;

    const staleCleared: string[] = [];
    for (const { role, backendKey, modelKey, label, listed } of roleFields) {
      const initialBackend = initial[backendKey];
      const initialModel = initial[modelKey] ?? "";
      if (role.backendId !== initialBackend) patch[backendKey] = role.backendId;
      const trimmed = role.model.trim();
      if (trimmed !== initialModel) patch[modelKey] = trimmed === "" ? null : trimmed;
      // A selection the fetched list proves stale is cleared with the save,
      // exactly as the warning on its tab promises — the server only verifies
      // when the same patch repoints a backend, which a leftover stale against
      // an unchanged backend never triggers.
      else if (listed && roleStale(role)) {
        patch[modelKey] = null;
        staleCleared.push(label);
      }
    }

    if (audioTranscriptionMode !== initial.audioTranscriptionMode) {
      patch.audioTranscriptionMode = audioTranscriptionMode;
    }
    if (botToken.dirty) patch.telegramBotToken = botToken.patchValue;
    if (tavilyKey.dirty) patch.tavilyApiKey = tavilyKey.patchValue;
    if (speechVoice.trim() !== (initial.speechVoice ?? "")) {
      patch.speechVoice = speechVoice.trim() === "" ? null : speechVoice.trim();
    }
    if (ownerUserId !== (initial.ownerUserId ?? "")) {
      patch.ownerUserId = ownerUserId === "" ? null : ownerUserId;
    }
    if (maintenanceMode !== initial.maintenanceModeEnabled) {
      patch.maintenanceModeEnabled = maintenanceMode;
    }
    if (timezone.trim() !== initial.timezone && timezone.trim() !== "") {
      patch.timezone = timezone.trim();
    }
    if (dailyJobsRunTime.trim() !== initial.dailyJobsRunTime && dailyJobsRunTime.trim() !== "") {
      patch.dailyJobsRunTime = dailyJobsRunTime.trim();
    }
    const limitGb = Number(browserDownloadLimitGb);
    if (
      Number.isInteger(limitGb) &&
      limitGb !== initial.browserDownloadLimitGb &&
      limitGb >= 1 &&
      limitGb <= 100
    ) {
      patch.browserDownloadLimitGb = limitGb;
    }

    // With every field sent changed-only, an untouched form produces an empty
    // patch, which the API rightly rejects — there is simply nothing to do.
    if (Object.keys(patch).length === 0) {
      setSave({ kind: "saved" });
      return;
    }

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setSave({ kind: "error", message: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: Settings };
      // Everything cleared for staleness gets named next to the Save button.
      // Two sources: what this client cleared from its fetched lists, and a
      // stored selection we did not send that came back null (the server
      // cleared it after verifying against a repointed backend).
      const cleared: string[] = [...staleCleared];
      for (const { role, modelKey, label } of roleFields) {
        if (!(modelKey in patch) && role.model !== "" && data[modelKey] === null) {
          cleared.push(label);
        }
      }
      setClearedOnSave(cleared);
      botToken.clear();
      tavilyKey.clear();
      chat.applySaved({ backendId: data.chatBackendId, model: data.model });
      emb.applySaved({ backendId: data.embeddingBackendId, model: data.embeddingModel });
      img.applySaved({ backendId: data.imageBackendId, model: data.imageModel });
      spc.applySaved({ backendId: data.speechBackendId, model: data.speechModel });
      aud.applySaved({ backendId: data.audioBackendId, model: data.audioModel });
      vis.applySaved({ backendId: data.visionBackendId, model: data.visionModel });
      brw.applySaved({ backendId: data.browserBackendId, model: data.browserModel });
      setSpeechVoice(data.speechVoice ?? "");
      setAudioTranscriptionMode(data.audioTranscriptionMode);
      setOwnerUserId(data.ownerUserId ?? "");
      setMaintenanceMode(data.maintenanceModeEnabled);
      setTimezone(data.timezone);
      setDailyJobsRunTime(data.dailyJobsRunTime);
      setBrowserDownloadLimitGb(String(data.browserDownloadLimitGb));
      setSave({ kind: "saved" });
      // Re-read server state so masked "configured" placeholders reflect the save.
      router.refresh();
    } catch {
      setSave({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  const chatBackend = backends.find((b) => b.id === chat.backendId) ?? null;
  const inheritLabel = chatBackend
    ? `Same backend as chat (${chatBackend.name})`
    : "Same backend as chat (not configured yet)";

  const noBackends = backends.length === 0;
  const noBackendsNote = noBackends ? (
    <p className="text-sm text-warning">
      No backends yet — add one on the Backends page first; every role here picks from that list.
    </p>
  ) : null;

  const chatTab = (
    <div className="space-y-5">
      {noBackendsNote}
      <RoleSection
        idPrefix="chat"
        labels={{
          intro:
            "The main backend and model every reply runs on. Pick a model that supports thinking and tool calls — replies reason before answering and drive every tool (history search, tasks, browsing). Roles on the other tabs use this backend unless given their own, so repointing it repoints them too, and any of their model selections the new backend does not serve is cleared on save.",
          backendHint:
            "The chat endpoint, from the shared catalog (managed on the Backends page).",
          modelLabel: "Model",
          modelHint: "The chat model used for replies. Type to search the backend's models.",
          modelPlaceholder: "Select a model…",
          testLabel: "Test connection",
        }}
        backends={backends}
        backendId={chat.backendId}
        onBackendChange={(next) => {
          chat.setBackendId(next);
          chatProbe.reset();
        }}
        inheritLabel={null}
        model={chat.model}
        onModelChange={chat.setModel}
        models={roleModels(chat)}
        modelWarning={roleStale(chat) ? staleWarning(chat.model) : null}
        probe={chatProbe.state}
        renderOk={(r) => <>Connected — {r.models.length} models</>}
        onTest={() => void onTestChat()}
        testDisabled={!chat.backendId}
      />
    </div>
  );

  const embeddingsTab = (
    <RoleSection
      idPrefix="embedding"
      labels={{
        intro:
          "Embeddings power semantic recall over older conversations: the daily job turns each chat-day into topic summaries and embeds them, so the bot can find what was discussed weeks ago even when the wording differs. Without an embedding model the summaries are still written and keyword-searchable — only the semantic half is off.",
        backendHint: "The host serving /v1/embeddings.",
        modelLabel: "Embedding model",
        modelHint: `Must emit ${EMBEDDING_DIMENSIONS}-dimensional vectors (e.g. bge-m3) — the width this database stores. Test below to confirm.`,
        modelPlaceholder: "No embedding model (semantic recall off)",
        testLabel: "Test embeddings",
      }}
      backends={backends}
      backendId={emb.backendId}
      onBackendChange={(next) => {
        emb.setBackendId(next);
        embedProbe.reset();
      }}
      inheritLabel={inheritLabel}
      model={emb.model}
      onModelChange={(next) => {
        emb.setModel(next);
        embedProbe.reset();
      }}
      models={roleModels(emb)}
      modelWarning={roleStale(emb) ? staleWarning(emb.model) : null}
      probe={embedProbe.state}
      renderOk={(r) => (
        <>
          {r.model} — {r.dimensions} dimensions
        </>
      )}
      onTest={() => void embedProbe.run(roleProbeBody(emb))}
      testDisabled={emb.model.trim() === ""}
    />
  );

  const imagesTab = (
    <RoleSection
      idPrefix="image"
      labels={{
        intro:
          "Image generation lets the bot draw a picture when someone asks it to, and send it to the chat. Each image it sends is then recognized like any received photo, so later replies know what it drew. Without an image model the tool is simply not offered — the bot says it cannot make images rather than pretending to.",
        backendHint: "The host serving /v1/images/generations.",
        modelLabel: "Image model",
        modelHint: "The model asked to draw. Test below to confirm the backend actually serves it.",
        modelPlaceholder: "No image model (image generation off)",
        testLabel: "Test image endpoint",
      }}
      backends={backends}
      backendId={img.backendId}
      onBackendChange={(next) => {
        img.setBackendId(next);
        imageProbe.reset();
      }}
      inheritLabel={inheritLabel}
      model={img.model}
      onModelChange={(next) => {
        img.setModel(next);
        imageProbe.reset();
      }}
      models={roleModels(img)}
      modelWarning={roleStale(img) ? staleWarning(img.model) : null}
      probe={imageProbe.state}
      renderOk={(r) => (
        <>
          {r.model} — served ({r.modelCount} models)
        </>
      )}
      onTest={() => void imageProbe.run(roleProbeBody(img))}
      testDisabled={img.model.trim() === ""}
    />
  );

  const speechTab = (
    <RoleSection
      idPrefix="speech"
      labels={{
        intro:
          "Speech lets the bot answer a voice message with a voice message: the reply text is synthesized on this endpoint and sent as a Telegram voice bubble. Without a speech model the bot still understands voice messages — it just always answers in text.",
        backendHint: "The host serving /v1/audio/speech.",
        modelLabel: "Speech model",
        modelHint:
          "The text-to-speech model voice replies use. Test below to confirm the backend actually serves it.",
        modelPlaceholder: "No speech model (voice replies off)",
        testLabel: "Test speech endpoint",
      }}
      backends={backends}
      backendId={spc.backendId}
      onBackendChange={(next) => {
        spc.setBackendId(next);
        speechProbe.reset();
      }}
      inheritLabel={inheritLabel}
      model={spc.model}
      onModelChange={(next) => {
        spc.setModel(next);
        speechProbe.reset();
      }}
      models={roleModels(spc)}
      modelWarning={roleStale(spc) ? staleWarning(spc.model) : null}
      probe={speechProbe.state}
      renderOk={(r) => (
        <>
          {r.model} — served ({r.modelCount} models)
        </>
      )}
      onTest={() => void speechProbe.run(roleProbeBody(spc))}
      testDisabled={spc.model.trim() === ""}
    >
      <Field
        id="speechVoice"
        label="Voice"
        hint="Voice name the endpoint should speak with (e.g. alloy). Leave blank for the endpoint's default."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={speechVoice}
            onChange={(e) => setSpeechVoice(e.target.value)}
            placeholder="alloy"
          />
        )}
      </Field>
    </RoleSection>
  );

  const audioTab = (
    <RoleSection
      idPrefix="audio"
      labels={{
        intro:
          "Audio turns incoming voice messages into text on a dedicated speech-to-text model. Whisper-class servers (whisper.cpp server, speaches, LocalAI…) take the audio on /v1/audio/transcriptions; providers like OpenRouter only take it through chat completions on an audio-capable model — pick the transcription mode to match. When no audio model is set, voice messages are transcribed by the chat model instead, which then must be audio-capable.",
        backendHint: "The host serving the speech-to-text model.",
        modelLabel: "Audio (STT) model",
        modelHint:
          "Free text — whisper-class servers often don't list models (e.g. whisper-1, Systran/faster-whisper-large-v3). Empty: voice falls back to the chat model.",
        modelPlaceholder: "No audio model (chat-model fallback)",
        testLabel: "Test audio",
      }}
      backends={backends}
      backendId={aud.backendId}
      onBackendChange={(next) => {
        aud.setBackendId(next);
        audioProbe.reset();
      }}
      inheritLabel={inheritLabel}
      model={aud.model}
      onModelChange={(next) => {
        aud.setModel(next);
        audioProbe.reset();
      }}
      models={roleModels(aud)}
      freeTextModel
      probe={audioProbe.state}
      renderOk={(r) => <>{r.model} — endpoint responded</>}
      onTest={() =>
        void audioProbe.run({ ...roleProbeBody(aud), transcriptionMode: audioTranscriptionMode })
      }
      testDisabled={aud.model.trim() === ""}
    >
      <Field
        id="audioTranscriptionMode"
        label="Transcription mode"
        hint="How the endpoint takes audio: the dedicated /v1/audio/transcriptions route (whisper-class servers), or a chat completion carrying the audio (OpenRouter and other chat-only providers)."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={audioTranscriptionMode}
            onChange={(e) => {
              setAudioTranscriptionMode(e.target.value as typeof audioTranscriptionMode);
              audioProbe.reset();
            }}
          >
            <option value="transcriptions">Transcriptions endpoint (/v1/audio/transcriptions)</option>
            <option value="chat">Chat completions (audio-capable chat model)</option>
          </Select>
        )}
      </Field>
    </RoleSection>
  );

  const visionTab = (
    <RoleSection
      idPrefix="vision"
      labels={{
        intro:
          "Vision describes every photo, video, GIF and sticker the bot receives, so replies and history search know what is in them. By default the chat model does the describing (it must then be vision-capable); give this role its own backend or model to run the describer elsewhere.",
        backendHint: "The host serving the vision-capable chat completions.",
        modelLabel: "Vision model",
        modelHint:
          "The multimodal model that describes media. Empty: the chat model is used.",
        modelPlaceholder: "Use the chat model",
        testLabel: "Test vision",
      }}
      backends={backends}
      backendId={vis.backendId}
      onBackendChange={(next) => {
        vis.setBackendId(next);
        visionProbe.reset();
      }}
      inheritLabel={inheritLabel}
      model={vis.model}
      onModelChange={(next) => {
        vis.setModel(next);
        visionProbe.reset();
      }}
      models={roleModels(vis)}
      modelWarning={roleStale(vis) ? staleWarning(vis.model) : null}
      probe={visionProbe.state}
      renderOk={(r) => <>{r.model} — described the test image</>}
      onTest={() => void visionProbe.run(roleProbeBody(vis))}
    />
  );

  const browserTab = (
    <RoleSection
      idPrefix="browser"
      labels={{
        intro:
          "The browser agent drives a real browser to research pages and download files when a chat asks for it. By default it thinks on the chat backend and model; give it its own here — for example a larger-context model — without touching replies.",
        backendHint: "The host serving the browsing agent's chat completions.",
        modelLabel: "Browser agent model",
        modelHint: "The model that plans browser actions. Empty: the chat model is used.",
        modelPlaceholder: "Use the chat model",
      }}
      backends={backends}
      backendId={brw.backendId}
      onBackendChange={brw.setBackendId}
      inheritLabel={inheritLabel}
      model={brw.model}
      onModelChange={brw.setModel}
      models={roleModels(brw)}
      modelWarning={roleStale(brw) ? staleWarning(brw.model) : null}
    />
  );

  const telegramTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        How the bot connects to Telegram and who operates it. Save the token, then start the bot
        from the Overview.
      </p>

      <Field
        id="telegramBotToken"
        label="Telegram bot token"
        hint="From @BotFather. Stored securely; never shown again. Save, then start the bot from the Overview."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={botToken.value}
            onChange={(e) => botToken.set(e.target.value)}
            placeholder={botToken.placeholderFor("123456:ABC-DEF…")}
          />
        )}
      </Field>

      <Field
        id="ownerUserId"
        label="Owner"
        hint={
          knownUsers.length > 0
            ? "The bot owner controls maintenance mode. Chosen from users who have messaged the bot."
            : "No users yet — the owner is chosen from people who have messaged the bot. Start the bot and message it first."
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={ownerUserId}
            disabled={knownUsers.length === 0}
            onChange={(e) => setOwnerUserId(e.target.value)}
          >
            <option value="">No owner</option>
            {knownUsers.map((u) => (
              <option key={u.userId} value={u.userId}>
                {formatKnownUserLabel(u)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field
        id="maintenanceMode"
        label="Maintenance mode"
        hint="When on, the bot stays fully functional for the owner only; everyone else gets a static maintenance notice."
      >
        {({ id, describedBy }) => (
          <div className="flex items-center gap-3">
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={maintenanceMode}
              onChange={(e) => setMaintenanceMode(e.target.checked)}
            />
            <span className="text-sm text-muted">{maintenanceMode ? "On" : "Off"}</span>
          </div>
        )}
      </Field>
    </div>
  );

  const generalTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Operational defaults that are not tied to any one backend or to Telegram.
      </p>

      <Field
        id="timezone"
        label="Timezone"
        hint="IANA timezone for scheduled tasks — a task at '09:00 daily' fires at 09:00 here. e.g. Europe/Berlin."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="UTC"
          />
        )}
      </Field>

      <Field
        id="dailyJobsRunTime"
        label="Daily jobs run time"
        hint="Local time (HH:MM, in the timezone above) the nightly jobs run: distilling user feedback into preferences, and compressing each finished chat-day into searchable topic summaries."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={dailyJobsRunTime}
            onChange={(e) => setDailyJobsRunTime(e.target.value)}
            placeholder="04:00"
          />
        )}
      </Field>

      <Field
        id="browserDownloadLimitGb"
        label="Browser download size limit (GB)"
        hint="Hard ceiling on a single download, whichever tool the agent uses — a file, a muxed stream, or a media extraction. A disk guard only: it never makes the agent pick a lower quality. 1–100."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={100}
            aria-describedby={describedBy}
            value={browserDownloadLimitGb}
            onChange={(e) => setBrowserDownloadLimitGb(e.target.value)}
            placeholder="10"
          />
        )}
      </Field>
    </div>
  );

  const integrationsTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Optional integrations that unlock extra tools. The bot runs without these.
      </p>

      <Field
        id="tavilyApiKey"
        label="Tavily API key"
        hint="Fallback search API for the browsing agent, used only when no search engine will load in the browser. Stored securely; never shown again."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={tavilyKey.value}
            onChange={(e) => tavilyKey.set(e.target.value)}
            placeholder={tavilyKey.placeholderFor("tvly-…")}
          />
        )}
      </Field>
    </div>
  );

  const tabs: TabItem[] = [
    { id: "chat", label: "Chat", content: chatTab },
    { id: "embeddings", label: "Embeddings", content: embeddingsTab },
    { id: "images", label: "Images", content: imagesTab },
    { id: "speech", label: "Speech", content: speechTab },
    { id: "audio", label: "Audio", content: audioTab },
    { id: "vision", label: "Vision", content: visionTab },
    { id: "browser", label: "Browser agent", content: browserTab },
    { id: "telegram", label: "Telegram", content: telegramTab },
    { id: "general", label: "General", content: generalTab },
    { id: "integrations", label: "Integrations", content: integrationsTab },
    { id: "security", label: "Security", content: <ChangePasswordSection /> },
  ];

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
      <Tabs tabs={tabs} value={activeTab} onValueChange={setActiveTab} />

      {activeTab !== "security" ? (
        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button
            type="button"
            onClick={onSave}
            disabled={save.kind === "saving"}
            leftIcon={<Save className="h-4 w-4" />}
          >
            {save.kind === "saving" ? "Saving…" : "Save settings"}
          </Button>
          {save.kind === "saved" ? (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <Check className="h-4 w-4" aria-hidden /> Saved
            </span>
          ) : null}
          {save.kind === "saved" && clearedOnSave.length > 0 ? (
            <span className="text-sm text-warning">
              Cleared {clearedOnSave.join(", ")} — not served by the configured backend. Pick
              replacements on their tabs when ready.
            </span>
          ) : null}
          {save.kind === "error" ? (
            <span className="text-sm text-danger">{save.message}</span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
