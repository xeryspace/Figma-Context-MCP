import { z } from "zod";
import { FramelinkService, type ToolResult } from "~/services/framelink.js";

const parameters = {
  projectCode: z
    .string()
    .describe(`The 2 to 5 letter code of the project to get tasks for, e.g. "FRA"`),
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const parametersSchema = z.object(parameters);
export type GetTasksParams = z.infer<typeof parametersSchema>;

async function getTasksHandler(
  { projectCode }: GetTasksParams,
  framelinkService: FramelinkService,
): Promise<ToolResult> {
  return await framelinkService.request(
    `/tasks?projectCode=${projectCode}`,
    { method: "GET" },
    async (data) => {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );
}

export const getTasksTool = {
  name: "get_tasks",
  description: "Get all tasks for a Framelink project",
  parameters,
  handler: getTasksHandler,
} as const;
