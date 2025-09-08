import { z } from "zod";
import { FramelinkService, type ToolResult } from "~/services/framelink.js";
import { Logger } from "~/utils/logger.js";

const parameters = {
  taskCode: z
    .string()
    .min(2, "Code is required")
    .regex(/^[A-Z]{2,5}(-\d+)?$/, "Code must be in format CODE or CODE-NUMBER (e.g., FRA or FRA-1)")
    .describe("The code of the task to update"),
  title: z
    .string()
    .min(1, "Task title is required")
    .max(255, "Task title too long")
    .optional()
    .describe("New title for the task"),
  description: z.string().optional().describe("New description for the task"),
  type: z.enum(["feature", "task", "question"]).optional().describe("New type for the task"),
  status: z.enum(["pending", "in-progress", "done"]).optional().describe("New status for the task"),
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const parametersSchema = z.object(parameters);
export type UpdateTaskParams = z.infer<typeof parametersSchema>;

async function updateTaskHandler(
  { taskCode, ...updates }: UpdateTaskParams,
  framelinkService: FramelinkService,
): Promise<ToolResult> {
  Logger.log("Updating task", taskCode, updates);
  // Filter out undefined values to only send fields that should be updated
  const updateData = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );

  return await framelinkService.request(
    `/tasks/${taskCode}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updateData),
    },
    async (data) => {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );
}

export const updateTaskTool = {
  name: "update_task",
  description: "Update a Framelink task's title, description, type, or status",
  parameters,
  handler: updateTaskHandler,
} as const;
