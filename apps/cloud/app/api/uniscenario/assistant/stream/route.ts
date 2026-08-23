import { NextRequest } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import {
  editorAssistantAvailable,
  streamEditorAssistant,
  type AssistantMessageParam,
  type EditorAssistantContext,
} from "@/app/lib/llm/editor-assistant";

export const maxDuration = 180;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export async function POST(req: NextRequest) {
  const auth = await requireRouteSession(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({ messages: [] }))) as {
    messages?: AssistantMessageParam[];
    editorContext?: EditorAssistantContext;
  };

  if (!editorAssistantAvailable()) {
    return echoStubResponse(body);
  }

  if (!body.editorContext?.mapAssetId) {
    return errorStreamResponse("Assistant context is missing a map asset.");
  }

  try {
    return assistantStreamResponse(
      body.messages ?? [],
      {
        ...body.editorContext,
        appContext: getAppContext(auth.session),
      },
    );
  } catch (error) {
    console.error("uniscenario assistant stream error:", error);
    return errorStreamResponse(
      error instanceof Error ? error.message : "Assistant failed",
    );
  }
}

function echoStubResponse(body: { messages?: AssistantMessageParam[] }) {
  const lastUserMsg = (body.messages ?? []).filter((m) => m.role === "user").pop();
  const echoText = `(Stub response — Anthropic API key not configured) You said: "${lastUserMsg?.content ?? ""}"`;
  return successStreamResponse(echoText, [], "Echoing your message back…");
}

function assistantStreamResponse(
  messages: AssistantMessageParam[],
  editorContext: EditorAssistantContext,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (eventName: string, payload: unknown) => {
        controller.enqueue(
          encoder.encode(
            `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      };

      try {
        enqueue("thinking", { text: "Running assistant with live model and tool streaming..." });
        await streamEditorAssistant(messages, editorContext, {
          onTextDelta: (text) => enqueue("delta", { text }),
          onToolStart: (trace) => {
            enqueue("thinking", { text: `\nCalling ${trace.name}...` });
            enqueue("tool_start", {
              name: trace.name,
              input: trace.input,
            });
          },
          onToolEnd: (trace) => {
            enqueue("thinking", { text: `\nFinished ${trace.name}.` });
            enqueue("tool_end", {
              name: trace.name,
              result: trace.result,
              uiActions: trace.uiActions ?? [],
            });
          },
        });
      } catch (error) {
        console.error("uniscenario assistant stream error:", error);
        enqueue("delta", {
          text:
            error instanceof Error
              ? error.message
              : "Assistant failed",
        });
      } finally {
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

function successStreamResponse(
  text: string,
  toolTraces: Array<{
    name: string;
    input?: unknown;
    result?: unknown;
    uiActions?: unknown[];
  }> = [],
  thinking = "Running assistant…",
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: thinking\ndata: ${JSON.stringify({ text: thinking })}\n\n`,
        ),
      );
      for (const trace of toolTraces) {
        controller.enqueue(
          encoder.encode(
            `event: tool_start\ndata: ${JSON.stringify({
              name: trace.name,
              input: trace.input,
            })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: tool_end\ndata: ${JSON.stringify({
              name: trace.name,
              result: trace.result,
              uiActions: trace.uiActions ?? [],
            })}\n\n`,
          ),
        );
      }
      for (const char of text) {
        controller.enqueue(
          encoder.encode(
            `event: delta\ndata: ${JSON.stringify({ text: char })}\n\n`,
          ),
        );
        await delay(5);
      }
      controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function errorStreamResponse(message: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: message })}\n\n`),
      );
      controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS, status: 200 });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
