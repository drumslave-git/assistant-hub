import { Download } from "lucide-react";

import { Button } from "@/components/ui";

/**
 * Shared log/trace bundle download control. Renders a plain `<a download>` (no
 * client JS) styled as a button, pointing at a `app/api/traces/**` bundle route.
 */
export function DownloadButton({
  href,
  label = "Download JSON",
}: {
  href: string;
  label?: string;
}) {
  return (
    <Button asChild variant="secondary" size="sm">
      <a href={href} download>
        <Download className="h-4 w-4" aria-hidden />
        {label}
      </a>
    </Button>
  );
}
