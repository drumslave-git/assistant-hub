import { Image as ImageIcon } from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  type BadgeTone,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";

import { mediaKindLabel } from "../format";
import type { MediaStatus, MediaView } from "../types";

/**
 * Read-only gallery of media the bot has received. A pending row shows its stored
 * image (awaiting description); a described row shows the model's text
 * description (its bytes are dropped). Server Component — no interactivity.
 */

const STATUS_TONE: Record<MediaStatus, BadgeTone> = {
  pending: "warning",
  described: "success",
  unavailable: "danger",
};

const STATUS_LABEL: Record<MediaStatus, string> = {
  pending: "Pending",
  described: "Described",
  unavailable: "Unavailable",
};

function MediaCard({ media }: { media: MediaView }) {
  const isVoice = media.kind === "voice";
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex aspect-video items-center justify-center overflow-hidden bg-surface-3">
        {isVoice && media.preview ? (
          // A pending voice message: its stored audio, playable while the bytes
          // still exist (they drop once transcribed, like image bytes do).
          <audio controls preload="none" src={media.preview} className="w-full px-3" />
        ) : media.frames && media.frames.length > 1 ? (
          // A video/GIF: the ordered grid of every sampled frame.
          <div className="grid h-full w-full grid-cols-5 gap-px bg-border">
            {media.frames.map((frame, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={frame}
                alt={`Frame ${i + 1}`}
                title={`Frame ${i + 1} of ${media.frames!.length}`}
                className="h-full w-full bg-surface-3 object-cover"
              />
            ))}
          </div>
        ) : media.preview ? (
          // Stored base64 thumbnail for a pending still image.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.preview} alt="" className="h-full w-full object-contain" />
        ) : (
          <p className="max-h-full overflow-y-auto p-3 text-xs text-muted">
            {media.description ?? "No preview"}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge tone="neutral">{mediaKindLabel(media.kind)}</Badge>
          <Badge tone={STATUS_TONE[media.status]} dot>
            {isVoice && media.status === "described" ? "Transcribed" : STATUS_LABEL[media.status]}
          </Badge>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-faint">
          <span className="truncate font-mono" title={`chat ${media.chatId}`}>
            {media.chatId}
          </span>
          <Timestamp iso={media.createdAt} />
        </div>
      </div>
    </div>
  );
}

export function MediaGallery({ media }: { media: MediaView[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Received media</CardTitle>
          <CardDescription>
            Images, stickers, video frames, and voice messages the bot has seen. Media on an
            answered message is described (voice: transcribed) immediately; the rest wait for the
            backfill job.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {media.length === 0 ? (
          <EmptyState
            icon={ImageIcon}
            title="No media yet"
            description="Send the bot a photo or sticker and it appears here."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {media.map((item) => (
              <MediaCard key={item.id} media={item} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
