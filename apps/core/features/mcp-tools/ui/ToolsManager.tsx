"use client";

import { Bug, Wrench } from "lucide-react";
import Link from "next/link";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Tabs,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import {
  ConnectionsManager,
  type AssistantOption,
} from "@/features/tool-connections/ui/ConnectionsManager";
import type { ToolConnection } from "@/features/tool-connections/server/schema";
import type { ToolView } from "../server/schema";

/**
 * The Tools page. Two tabs over one subject: what the assistants can call,
 * and where those tools come from.
 *
 * The first tab is a catalog, not a switchboard — a feature tool is always
 * offered, and a connection tool is offered wherever its connection's scope
 * says, which is shown beside it rather than left for the operator to work
 * out. Configuration lives in the second tab, where a connection is added,
 * scoped, discovered and applied.
 */

/** How one group of tools is titled and where its Debug scope lives. */
function groupOf(tool: ToolView): { key: string; title: string; feature: string } {
  if (tool.connection) {
    return {
      key: `connection:${tool.connection.id}`,
      title: tool.connection.name,
      feature: "connections",
    };
  }
  return { key: `feature:${tool.feature}`, title: tool.feature, feature: tool.feature };
}

function ToolsCatalog({ tools }: { tools: ToolView[] }) {
  if (tools.length === 0) {
    return (
      <EmptyState
        icon={Wrench}
        title="No tools available"
        description="Feature tools are registered in code; a connection's tools appear once its discovery is applied."
      />
    );
  }

  const groups = new Map<string, { title: string; feature: string; tools: ToolView[] }>();
  for (const tool of tools) {
    const { key, title, feature } = groupOf(tool);
    const group = groups.get(key) ?? { title, feature, tools: [] };
    group.tools.push(tool);
    groups.set(key, group);
  }

  return (
    <div className="space-y-6">
      {[...groups.values()].map((group) => {
        const connection = group.tools[0].connection;
        return (
          <Card key={group.title + group.feature}>
            <CardHeader>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <CardTitle className={connection ? "truncate" : "truncate capitalize"}>
                  {group.title}
                </CardTitle>
                {connection ? (
                  <>
                    <Badge tone="info">connection</Badge>
                    {connection.enabled ? null : <Badge tone="neutral">disabled</Badge>}
                  </>
                ) : null}
              </div>
              <CardAction>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/debug?feature=mcp-tools-${encodeURIComponent(group.feature)}`}>
                    <Bug className="h-4 w-4" aria-hidden />
                    Debug
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              <CardDescription className="pb-3">
                {group.tools.length} tool{group.tools.length === 1 ? "" : "s"}
                {connection ? ` · offered on ${scopeSentence(connection.scope)}` : " · always offered"}
              </CardDescription>
              {group.tools.map((tool) => (
                <div key={tool.name} className="py-3">
                  <code className="text-sm font-medium text-foreground">{tool.name}</code>
                  <p className="mt-1 text-sm text-muted">{tool.description}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** Where a connection's tools reach, in words the page can put in a line. */
function scopeSentence(scope: NonNullable<ToolView["connection"]>["scope"]): string {
  const where = scope.appScope ? `${scope.appScope} turns` : "every source";
  if (scope.allAssistants) return `${where}, for every assistant`;
  if (scope.assistantCount === 0) return `${where} — but no assistant is selected`;
  return `${where}, for ${scope.assistantCount} assistant${scope.assistantCount === 1 ? "" : "s"}`;
}

export function ToolsManager({
  tools,
  connections,
  assistants,
}: {
  tools: ToolView[];
  connections: ToolConnection[];
  assistants: AssistantOption[];
}) {
  // Applying a snapshot, adding a connection, or a source app coming back
  // changes this page without anybody reloading it.
  useLiveRefresh("tools");

  return (
    <Tabs
      tabs={[
        {
          id: "tools",
          label: `Tools (${tools.length})`,
          content: <ToolsCatalog tools={tools} />,
        },
        {
          id: "connections",
          label: `Connections (${connections.length})`,
          content: <ConnectionsManager connections={connections} assistants={assistants} />,
        },
      ]}
    />
  );
}
