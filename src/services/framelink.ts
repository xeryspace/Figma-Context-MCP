import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { Logger } from "~/utils/logger.js";

export type ToolResult = z.infer<typeof CallToolResultSchema>;

export type FramelinkAuthOptions = {
  active: boolean;
  accessToken?: string;
  baseUrl?: string;
};

export class FramelinkService {
  private readonly accessToken?: string;
  private readonly baseUrl: string;

  constructor({
    accessToken,
    baseUrl = "https://www.framelink.com/mcp-api/v1",
  }: FramelinkAuthOptions) {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
  }

  private getAuthHeaders(): Record<string, string> {
    if (this.accessToken) {
      return { "X-Framelink-Token": this.accessToken } as const;
    } else {
      throw new Error("Framelink access token is required");
    }
  }

  async request<T>(
    /**
     * The endpoint to fetch from.
     *
     * Example: "/tasks" or "/tasks/FRA-1"
     */
    endpoint: string,
    options: RequestInit,
    callback: (data: T) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      Logger.log(`Fetching ${url}`);
      const response = await fetch(url, {
        ...options,
        headers: { ...this.getAuthHeaders(), ...options.headers },
      });
      Logger.log(`Response: ${response.status} ${response.statusText}`);

      const error = await this.handleFetchError(response);
      if (error) return error;

      const data = await response.json();
      return await callback(data);
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }

  /**
   * Handle fetch errors by checking to see if the invalid response is an MCP-formatted error
   * and returning. Otherwise, throw a generic error.
   */
  async handleFetchError(response: Response): Promise<ToolResult | undefined> {
    if (!response.ok) {
      const errorMessage = JSON.parse(await response.text());

      // If the error message is a valid MCP response, return it as is
      if (CallToolResultSchema.safeParse(errorMessage).success) {
        return errorMessage as ToolResult;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}
