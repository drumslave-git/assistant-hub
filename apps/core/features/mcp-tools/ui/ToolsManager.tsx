import { Bug, Wrench } from "lucide-react";
import Link from "next/link";

import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from "@/components/ui";
import type { ToolView } from "../server/schema";

/**
 * Tools list. Read-only: every registered MCP tool grouped by the feature that
 * contributes it. All registered tools are always available to the model during a
 * reply — this page is for operator visibility, not configuration.
 */
export function ToolsManager({ tools }: { tools: ToolView[] }) {
  if (tools.length === 0) {
    return (
      <EmptyState
        icon={Wrench}
        title="No tools registered"
        description="Tool-owning features register their MCP tools in code. None are available yet."
      />
    );
  }

  // Group by contributing feature so related tools sit together.
  const byFeature = new Map<string, ToolView[]>();
  for (const tool of tools) {
    const list = byFeature.get(tool.feature) ?? [];
    list.push(tool);
    byFeature.set(tool.feature, list);
  }

  return (
    <div className="space-y-6">
      {[...byFeature.entries()].map(([feature, featureTools]) => (
        <Card key={feature}>
          <CardHeader>
            <div>
              <CardTitle className="capitalize">{feature}</CardTitle>
              <CardDescription>
                {featureTools.length} tool{featureTools.length === 1 ? "" : "s"}
              </CardDescription>
            </div>
            <CardAction>
              <Button asChild variant="outline" size="sm">
                <Link href={`/debug?feature=mcp-tools-${encodeURIComponent(feature)}`}>
                  <Bug className="h-4 w-4" aria-hidden />
                  Debug
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {featureTools.map((tool) => (
              <div key={tool.name} className="py-3">
                <code className="text-sm font-medium text-foreground">{tool.name}</code>
                <p className="mt-1 text-sm text-muted">{tool.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
