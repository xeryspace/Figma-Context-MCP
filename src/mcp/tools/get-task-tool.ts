import { z } from "zod";
import { FramelinkService, type ToolResult } from "~/services/framelink.js";

const parameters = {
  taskCode: z.string().describe(`The code of the task to get, e.g. "FRA-123"`),
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const parametersSchema = z.object(parameters);
export type GetTaskParams = z.infer<typeof parametersSchema>;

async function getTaskHandler(
  { taskCode }: GetTaskParams,
  framelinkService: FramelinkService,
): Promise<ToolResult> {
  return await framelinkService.request(`/tasks/${taskCode}`, { method: "GET" }, async (data) => {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    };
  });
}

export const getTaskTool = {
  name: "get_task",
  description: "Get a Framelink task by its code",
  parameters,
  handler: getTaskHandler,
} as const;
