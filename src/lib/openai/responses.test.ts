import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultOpenAIModel, streamOpenAITextResponse } from "./responses";
import { mockFetch, sseResponse, withEnv } from "../../test/helpers";

test("chat default model falls back to GPT-5.2", async () => {
  await withEnv({}, async () => {
    assert.equal(getDefaultOpenAIModel("chat"), "gpt-5.2");
  });
});

test("OpenAI streaming preserves whitespace in output deltas", async () => {
  const restore = mockFetch(() =>
    sseResponse([
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "Halo",
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: " semuanya",
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: ".\n\n- Satu",
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp-test",
          model: "gpt-5-mini",
          usage: {
            input_tokens: 3,
            output_tokens: 5,
            total_tokens: 8,
          },
        },
      })}`,
      "",
    ])
  );
  const deltas: string[] = [];

  try {
    await withEnv(
      {
        OPENAI_API_KEY: "test-key",
      },
      async () => {
        const result = await streamOpenAITextResponse({
          input: "halo",
          model: "gpt-5-mini",
          onDelta: (delta) => deltas.push(delta),
        });

        assert.equal(result.text, "Halo semuanya.\n\n- Satu");
        assert.deepEqual(deltas, ["Halo", " semuanya", ".\n\n- Satu"]);
        assert.equal(result.usage?.totalTokens, 8);
      }
    );
  } finally {
    restore();
  }
});
