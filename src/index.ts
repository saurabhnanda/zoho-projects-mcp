#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";

interface ZohoConfig {
  accessToken: string;
  portalId: string;
  apiDomain?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  accountsDomain?: string;
}

class ZohoProjectsServer {
  private server: Server;
  private config: ZohoConfig;
  private baseUrl: string = "https://projectsapi.zoho.com/api/v3";
  private tokenExpiresAt: number = 0; // Unix timestamp in milliseconds

  constructor() {
    this.server = new Server(
      {
        name: "zoho-projects-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Load configuration from environment variables
    this.config = {
      accessToken: process.env.ZOHO_ACCESS_TOKEN || "",
      portalId: process.env.ZOHO_PORTAL_ID || "",
      apiDomain: process.env.ZOHO_API_DOMAIN || "https://projectsapi.zoho.com",
      refreshToken: process.env.ZOHO_REFRESH_TOKEN || "",
      clientId: process.env.ZOHO_CLIENT_ID || "",
      clientSecret: process.env.ZOHO_CLIENT_SECRET || "",
      accountsDomain: process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com",
    };

    if (this.config.apiDomain) {
      this.baseUrl = `${this.config.apiDomain}/api/v3`;
    }

    // If no access token provided, set expiration to 0 to force immediate refresh
    this.tokenExpiresAt = this.config.accessToken ? Date.now() + 3600 * 1000 : 0;

    this.setupHandlers();
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.config.refreshToken || !this.config.clientId || !this.config.clientSecret) {
      console.error("Cannot refresh token: missing refresh token, client ID, or client secret");
      return;
    }

    try {
      const params = new URLSearchParams({
        refresh_token: this.config.refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
      });

      const response = await fetch(`${this.config.accountsDomain}/oauth/v2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        access_token: string;
        expires_in: number;
      };

      // Update access token and expiration time
      this.config.accessToken = data.access_token;
      // Set expiration to 5 minutes before actual expiry for safety margin
      this.tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;

      console.error(`Access token refreshed successfully. Expires in ${data.expires_in} seconds.`);
    } catch (error) {
      console.error(`Error refreshing access token: ${error}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to refresh access token: ${error}`
      );
    }
  }

  private async makeRequest(
    endpoint: string,
    method: string = "GET",
    body?: any,
    isRetry: boolean = false
  ): Promise<any> {
    // Check if token needs refresh (5 minutes before expiry)
    if (Date.now() >= this.tokenExpiresAt) {
      await this.refreshAccessToken();
    }

    if (!this.config.accessToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Zoho access token not configured. Set ZOHO_ACCESS_TOKEN environment variable."
      );
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${this.config.accessToken}`,
      "Content-Type": "application/json",
    };

    const options: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    } = {
      method,
      headers,
    };

    if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();

      // If 401 and we have refresh credentials and haven't retried yet, try refresh
      if (response.status === 401 && !isRetry &&
          this.config.refreshToken && this.config.clientId && this.config.clientSecret) {
        console.error("Received 401 error, attempting token refresh...");
        try {
          await this.refreshAccessToken();
          // Retry the request once with new token
          return await this.makeRequest(endpoint, method, body, true);
        } catch (refreshError) {
          console.error("Token refresh failed:", refreshError);
          // Fall through to throw original error
        }
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Zoho API error: ${response.status} - ${errorText}`
      );
    }

    return response.json();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // Portal operations
        {
          name: "list_portals",
          description: "Retrieve all Zoho Projects portals",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "get_portal",
          description: "Get details of a specific portal",
          inputSchema: {
            type: "object",
            properties: {
              portal_id: { type: "string", description: "Portal ID" },
            },
            required: ["portal_id"],
          },
        },

        // Project operations
        {
          name: "list_projects",
          description: "List all projects in a portal",
          inputSchema: {
            type: "object",
            properties: {
              page: { type: "number", description: "Page number", default: 1 },
              per_page: {
                type: "number",
                description: "Items per page",
                default: 10,
              },
            },
          },
        },
        {
          name: "get_project",
          description: "Get details of a specific project",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
            },
            required: ["project_id"],
          },
        },
        {
          name: "create_project",
          description: "Create a new project",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Project name" },
              description: { type: "string", description: "Project description" },
              start_date: {
                type: "string",
                description: "Start date (YYYY-MM-DD)",
              },
              end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
              is_public: {
                type: "boolean",
                description: "Is project public",
                default: false,
              },
            },
            required: ["name"],
          },
        },
        {
          name: "update_project",
          description: "Update an existing project",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              name: { type: "string", description: "Project name" },
              description: { type: "string", description: "Project description" },
              start_date: {
                type: "string",
                description: "Start date (YYYY-MM-DD)",
              },
              end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
              status: {
                type: "string",
                description: "Project status",
                enum: ["active", "template", "archived"],
              },
            },
            required: ["project_id"],
          },
        },
        {
          name: "delete_project",
          description: "Delete a project (moves to trash)",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
            },
            required: ["project_id"],
          },
        },

        // Task operations
        {
          name: "list_tasks",
          description: "List tasks from a project or portal",
          inputSchema: {
            type: "object",
            properties: {
              project_id: {
                type: "string",
                description: "Project ID (optional for portal-level)",
              },
              page: { type: "number", description: "Page number", default: 1 },
              per_page: {
                type: "number",
                description: "Items per page",
                default: 10,
              },
              sort_by: {
                type: "string",
                description: "Sort criteria in format ASC(field) or DESC(field). Fields: last_modified_time, created_time. Example: DESC(last_modified_time)",
              },
            },
          },
        },
        {
          name: "get_task",
          description: "Get details of a specific task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
            },
            required: ["project_id", "task_id"],
          },
        },
        {
          name: "create_task",
          description: "Create a new task in a project",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              tasklist_id: { type: "string", description: "Task list ID (required if project has no default task list)" },
              name: { type: "string", description: "Task name" },
              description: { type: "string", description: "Task description" },
              priority: {
                type: "string",
                description: "Task priority",
                enum: ["none", "low", "medium", "high"],
              },
              start_date: {
                type: "string",
                description: "Start date (YYYY-MM-DD)",
              },
              end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
              assignee_zpuid: {
                type: "string",
                description: "Assignee user ZPUID",
              },
            },
            required: ["project_id", "name"],
          },
        },
        {
          name: "update_task",
          description: "Update a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
              name: { type: "string", description: "Task name" },
              description: { type: "string", description: "Task description" },
              priority: {
                type: "string",
                description: "Task priority",
                enum: ["none", "low", "medium", "high"],
              },
              start_date: {
                type: "string",
                description: "Start date (YYYY-MM-DD)",
              },
              end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
            },
            required: ["project_id", "task_id"],
          },
        },
        {
          name: "delete_task",
          description: "Delete a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
            },
            required: ["project_id", "task_id"],
          },
        },

        // Issue operations
        {
          name: "list_issues",
          description: "List issues from a project or portal",
          inputSchema: {
            type: "object",
            properties: {
              project_id: {
                type: "string",
                description: "Project ID (optional for portal-level)",
              },
              page: { type: "number", description: "Page number", default: 1 },
              per_page: {
                type: "number",
                description: "Items per page",
                default: 10,
              },
            },
          },
        },
        {
          name: "get_issue",
          description: "Get details of a specific issue",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              issue_id: { type: "string", description: "Issue ID" },
            },
            required: ["project_id", "issue_id"],
          },
        },
        {
          name: "create_issue",
          description: "Create a new issue",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              title: { type: "string", description: "Issue title" },
              description: { type: "string", description: "Issue description" },
              severity: {
                type: "string",
                description: "Issue severity",
                enum: ["minor", "major", "critical"],
              },
              due_date: { type: "string", description: "Due date (YYYY-MM-DD)" },
            },
            required: ["project_id", "title"],
          },
        },
        {
          name: "update_issue",
          description: "Update an issue",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              issue_id: { type: "string", description: "Issue ID" },
              title: { type: "string", description: "Issue title" },
              description: { type: "string", description: "Issue description" },
              severity: {
                type: "string",
                description: "Issue severity",
                enum: ["minor", "major", "critical"],
              },
            },
            required: ["project_id", "issue_id"],
          },
        },

        // Milestone/Phase operations
        {
          name: "list_phases",
          description: "List phases/milestones from a project",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              page: { type: "number", description: "Page number", default: 1 },
              per_page: {
                type: "number",
                description: "Items per page",
                default: 10,
              },
            },
            required: ["project_id"],
          },
        },
        {
          name: "create_phase",
          description: "Create a new phase/milestone",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              name: { type: "string", description: "Phase name" },
              start_date: {
                type: "string",
                description: "Start date (YYYY-MM-DD)",
              },
              end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
              owner_zpuid: { type: "string", description: "Owner user ZPUID" },
            },
            required: ["project_id", "name"],
          },
        },

        // Search
        {
          name: "search",
          description: "Search across portal or project",
          inputSchema: {
            type: "object",
            properties: {
              search_term: {
                type: "string",
                description: "Search term/query",
              },
              project_id: {
                type: "string",
                description: "Project ID (optional for portal-level search)",
              },
              module: {
                type: "string",
                description: "Module to search in",
                enum: [
                  "all",
                  "projects",
                  "tasks",
                  "issues",
                  "milestones",
                  "forums",
                  "events",
                ],
              },
              page: { type: "number", description: "Page number", default: 1 },
              per_page: {
                type: "number",
                description: "Items per page",
                default: 10,
              },
            },
            required: ["search_term"],
          },
        },

        // Users
        {
          name: "list_users",
          description: "List users in a portal or project",
          inputSchema: {
            type: "object",
            properties: {
              project_id: {
                type: "string",
                description: "Project ID (optional for portal-level)",
              },
            },
          },
        },

        // Task Lists
        {
          name: "list_tasklists",
          description: "List all task lists in a project. Use name_contains to filter by name and avoid huge responses.",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              name_contains: {
                type: "string",
                description: "Filter tasklists where name contains this string (server-side filter via Zoho API). RECOMMENDED to avoid huge responses."
              },
              minimal: {
                type: "boolean",
                description: "Return minimal response (id, name only). Default: true",
                default: true
              },
            },
            required: ["project_id"],
          },
        },
        {
          name: "create_tasklist",
          description: "Create a new task list in a project",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              name: { type: "string", description: "Task list name" },
              flag: {
                type: "string",
                description: "Task list visibility",
                enum: ["internal", "external"],
              },
              milestone_id: { type: "string", description: "Associated milestone ID" },
            },
            required: ["project_id", "name"],
          },
        },
        {
          name: "update_tasklist",
          description: "Update a task list",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              tasklist_id: { type: "string", description: "Task list ID" },
              name: { type: "string", description: "Task list name" },
              status: {
                type: "string",
                description: "Task list status",
                enum: ["active", "completed"],
              },
            },
            required: ["project_id", "tasklist_id"],
          },
        },
        {
          name: "delete_tasklist",
          description: "Delete a task list",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              tasklist_id: { type: "string", description: "Task list ID" },
            },
            required: ["project_id", "tasklist_id"],
          },
        },

        // Task Comments
        {
          name: "list_task_comments",
          description: "List all comments on a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
              minimal: {
                type: "boolean",
                description: "Return minimal response (id, created_time, author, comment, attachments[{id,name,type}]). Set to false for full response. Default: true",
                default: true
              },
              since: {
                type: "string",
                description: "Only return comments created or modified after this ISO date (e.g., 2026-01-14T00:00:00Z). Useful for incremental checks."
              },
            },
            required: ["project_id", "task_id"],
          },
        },
        {
          name: "create_task_comment",
          description: "Add a comment to a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
              content: { type: "string", description: "Comment content (can include HTML)" },
            },
            required: ["project_id", "task_id", "content"],
          },
        },
        {
          name: "update_task_comment",
          description: "Update a comment on a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
              comment_id: { type: "string", description: "Comment ID" },
              content: { type: "string", description: "Updated comment content" },
            },
            required: ["project_id", "task_id", "comment_id", "content"],
          },
        },
        {
          name: "delete_task_comment",
          description: "Delete a comment from a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
              comment_id: { type: "string", description: "Comment ID" },
            },
            required: ["project_id", "task_id", "comment_id"],
          },
        },

        // Task Attachments
        {
          name: "list_task_attachments",
          description: "List all attachments on a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
            },
            required: ["project_id", "task_id"],
          },
        },
        {
          name: "delete_task_attachment",
          description: "Delete an attachment from a task",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              task_id: { type: "string", description: "Task ID" },
              attachment_id: { type: "string", description: "Attachment ID" },
            },
            required: ["project_id", "task_id", "attachment_id"],
          },
        },

        // Inline Image Download
        {
          name: "download_inline_image",
          description: "Download an inline image from a comment. The image URL can be found in the 'comment' field of task comments as an <img> tag with src containing 'viewInlineAttachment'. Returns the image as base64-encoded data.",
          inputSchema: {
            type: "object",
            properties: {
              image_url: {
                type: "string",
                description: "The full inline image URL (e.g., https://projects.zoho.com/viewInlineAttachment/image?file=projects-...)"
              },
            },
            required: ["image_url"],
          },
        },

        // Comment Attachment Download
        {
          name: "download_comment_attachment",
          description: "Download an attachment from a task comment. Use the attachment_id from the 'attachments' array in task comments. Returns the file as base64-encoded data.",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              attachment_id: { type: "string", description: "Attachment ID from the comment's attachments array" },
            },
            required: ["project_id", "attachment_id"],
          },
        },

        // Feeds (activity stream)
        {
          name: "list_feeds",
          description: "List activity feed/stream for the portal (shows recent activity across all projects)",
          inputSchema: {
            type: "object",
            properties: {
              count: { type: "number", description: "Number of feed items to return", default: 20 },
              viewkey: { type: "string", description: "View key filter", default: "all" },
            },
          },
        },

        // Tasks in Tasklist
        {
          name: "list_tasks_in_tasklist",
          description: "List all tasks in a specific tasklist",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project ID" },
              tasklist_id: { type: "string", description: "Tasklist ID" },
              page: { type: "number", description: "Page number", default: 1 },
              per_page: { type: "number", description: "Items per page", default: 100 },
              sort_by: {
                type: "string",
                description: "Sort criteria in format ASC(field) or DESC(field). Fields: last_modified_time, created_time. Example: DESC(last_modified_time)",
              },
            },
            required: ["project_id", "tasklist_id"],
          },
        },
      ],
    }));

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Cast args to any since JSON schema validation handles type safety
      const params = (args || {}) as any;

      try {
        switch (name) {
          // Portal operations
          case "list_portals":
            return await this.listPortals();
          case "get_portal":
            return await this.getPortal(params.portal_id);

          // Project operations
          case "list_projects":
            return await this.listProjects(params.page, params.per_page);
          case "get_project":
            return await this.getProject(params.project_id);
          case "create_project":
            return await this.createProject(params);
          case "update_project":
            return await this.updateProject(params);
          case "delete_project":
            return await this.deleteProject(params.project_id);

          // Task operations
          case "list_tasks":
            return await this.listTasks(params.project_id, params.page, params.per_page, params.sort_by);
          case "get_task":
            return await this.getTask(params.project_id, params.task_id);
          case "create_task":
            return await this.createTask(params);
          case "update_task":
            return await this.updateTask(params);
          case "delete_task":
            return await this.deleteTask(params.project_id, params.task_id);

          // Issue operations
          case "list_issues":
            return await this.listIssues(params.project_id, params.page, params.per_page);
          case "get_issue":
            return await this.getIssue(params.project_id, params.issue_id);
          case "create_issue":
            return await this.createIssue(params);
          case "update_issue":
            return await this.updateIssue(params);

          // Phase operations
          case "list_phases":
            return await this.listPhases(params.project_id, params.page, params.per_page);
          case "create_phase":
            return await this.createPhase(params);

          // Search
          case "search":
            return await this.search(params);

          // Users
          case "list_users":
            return await this.listUsers(params.project_id);

          // Task Lists
          case "list_tasklists":
            return await this.listTasklists(params.project_id, params.name_contains, params.minimal !== false);
          case "create_tasklist":
            return await this.createTasklist(params);
          case "update_tasklist":
            return await this.updateTasklist(params);
          case "delete_tasklist":
            return await this.deleteTasklist(params.project_id, params.tasklist_id);

          // Task Comments
          case "list_task_comments":
            return await this.listTaskComments(
              params.project_id,
              params.task_id,
              params.minimal !== false, // default true
              params.since
            );
          case "create_task_comment":
            return await this.createTaskComment(params);
          case "update_task_comment":
            return await this.updateTaskComment(params);
          case "delete_task_comment":
            return await this.deleteTaskComment(params.project_id, params.task_id, params.comment_id);

          // Task Attachments
          case "list_task_attachments":
            return await this.listTaskAttachments(params.project_id, params.task_id);
          case "delete_task_attachment":
            return await this.deleteTaskAttachment(params.project_id, params.task_id, params.attachment_id);

          // Inline Image Download
          case "download_inline_image":
            return await this.downloadInlineImage(params.image_url);

          // Comment Attachment Download
          case "download_comment_attachment":
            return await this.downloadCommentAttachment(params.project_id, params.attachment_id);

          // Feeds
          case "list_feeds":
            return await this.listFeeds(params.count, params.viewkey);

          // Tasks in Tasklist
          case "list_tasks_in_tasklist":
            return await this.listTasksInTasklist(params.project_id, params.tasklist_id, params.page, params.per_page, params.sort_by);

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing ${name}: ${error}`
        );
      }
    });
  }

  // Portal operations
  private async listPortals() {
    const data = await this.makeRequest("/portals");
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async getPortal(portalId: string) {
    const data = await this.makeRequest(`/portal/${portalId}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  // Project operations
  private async listProjects(page: number = 1, perPage: number = 10) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects?page=${page}&per_page=${perPage}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async getProject(projectId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async createProject(params: any) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects`,
      "POST",
      params
    );
    return {
      content: [
        {
          type: "text",
          text: `Project created successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async updateProject(params: any) {
    const { project_id, ...updateData } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}`,
      "PATCH",
      updateData
    );
    return {
      content: [
        {
          type: "text",
          text: `Project updated successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async deleteProject(projectId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/trash`,
      "POST"
    );
    return {
      content: [
        {
          type: "text",
          text: `Project moved to trash successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  // Task operations
  private async listTasks(
    projectId?: string,
    page: number = 1,
    perPage: number = 10,
    sortBy?: string
  ) {
    let queryParams = `page=${page}&per_page=${perPage}`;
    if (sortBy) queryParams += `&sort_by=${encodeURIComponent(sortBy)}`;

    const endpoint = projectId
      ? `/portal/${this.config.portalId}/projects/${projectId}/tasks?${queryParams}`
      : `/portal/${this.config.portalId}/tasks?${queryParams}`;
    const data = await this.makeRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async getTask(projectId: string, taskId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasks/${taskId}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async createTask(params: any) {
    const { project_id, tasklist_id, ...taskData } = params;
    // Zoho API expects 'tasklist' field, not 'tasklist_id'
    if (tasklist_id) {
      taskData.tasklist = { id: tasklist_id };
    }
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/tasks`,
      "POST",
      taskData
    );
    return {
      content: [
        {
          type: "text",
          text: `Task created successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async updateTask(params: any) {
    const { project_id, task_id, ...taskData } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/tasks/${task_id}`,
      "PATCH",
      taskData
    );
    return {
      content: [
        {
          type: "text",
          text: `Task updated successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async deleteTask(projectId: string, taskId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasks/${taskId}`,
      "DELETE"
    );
    return {
      content: [
        {
          type: "text",
          text: `Task deleted successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  // Issue operations
  private async listIssues(
    projectId?: string,
    page: number = 1,
    perPage: number = 10
  ) {
    const endpoint = projectId
      ? `/portal/${this.config.portalId}/projects/${projectId}/issues?page=${page}&per_page=${perPage}`
      : `/portal/${this.config.portalId}/issues?page=${page}&per_page=${perPage}`;
    const data = await this.makeRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async getIssue(projectId: string, issueId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/issues/${issueId}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async createIssue(params: any) {
    const { project_id, ...issueData } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/issues`,
      "POST",
      issueData
    );
    return {
      content: [
        {
          type: "text",
          text: `Issue created successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async updateIssue(params: any) {
    const { project_id, issue_id, ...issueData } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/issues/${issue_id}`,
      "PATCH",
      issueData
    );
    return {
      content: [
        {
          type: "text",
          text: `Issue updated successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  // Phase operations
  private async listPhases(
    projectId: string,
    page: number = 1,
    perPage: number = 10
  ) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/phases?page=${page}&per_page=${perPage}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async createPhase(params: any) {
    const { project_id, ...phaseData } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/phases`,
      "POST",
      phaseData
    );
    return {
      content: [
        {
          type: "text",
          text: `Phase created successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  // Search
  private async search(params: any) {
    const { search_term, project_id, module = "all", page = 1, per_page = 10 } = params;
    const endpoint = project_id
      ? `/portal/${this.config.portalId}/projects/${project_id}/search?search_term=${encodeURIComponent(search_term)}&module=${module}&page=${page}&per_page=${per_page}`
      : `/portal/${this.config.portalId}/search?search_term=${encodeURIComponent(search_term)}&module=${module}&status=active&page=${page}&per_page=${per_page}`;
    const data = await this.makeRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  // Users
  private async listUsers(projectId?: string) {
    const endpoint = projectId
      ? `/portal/${this.config.portalId}/projects/${projectId}/users`
      : `/portal/${this.config.portalId}/users`;
    const data = await this.makeRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  // Task Lists
  private async listTasklists(projectId: string, nameContains?: string, minimal: boolean = true) {
    const url = `/portal/${this.config.portalId}/projects/${projectId}/tasklists`;
    const data = await this.makeRequest(url);

    let tasklists = data.tasklists || [];

    // Filter by name if name_contains provided (client-side filter)
    if (nameContains) {
      const searchLower = nameContains.toLowerCase();
      tasklists = tasklists.filter((t: any) =>
        t.name && t.name.toLowerCase().includes(searchLower)
      );
    }

    // Return minimal format if requested (default)
    if (minimal) {
      const minimalTasklists = tasklists.map((t: any) => ({
        id: t.id,
        name: t.name,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ tasklists: minimalTasklists }, null, 2) }],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ ...data, tasklists }, null, 2) }],
    };
  }

  private async createTasklist(params: any) {
    const { project_id, ...tasklistData } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/tasklists`,
      "POST",
      tasklistData
    );
    return {
      content: [
        {
          type: "text",
          text: `Task list created successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async updateTasklist(params: any) {
    const { project_id, tasklist_id, ...tasklistData } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/tasklists/${tasklist_id}`,
      "PATCH",
      tasklistData
    );
    return {
      content: [
        {
          type: "text",
          text: `Task list updated successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async deleteTasklist(projectId: string, tasklistId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasklists/${tasklistId}`,
      "DELETE"
    );
    return {
      content: [
        {
          type: "text",
          text: `Task list deleted successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  // Task Comments
  private async listTaskComments(
    projectId: string,
    taskId: string,
    minimal: boolean = true,
    since?: string
  ) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasks/${taskId}/comments`
    );

    let comments = data.comments || [];

    // Filter by date if 'since' provided (checks both created_time and updated_time)
    if (since) {
      const sinceDate = new Date(since);
      comments = comments.filter((c: any) => {
        const createdDate = new Date(c.created_time);
        const updatedDate = c.updated_time ? new Date(c.updated_time) : null;
        return createdDate > sinceDate || (updatedDate && updatedDate > sinceDate);
      });
    }

    // Return minimal format if requested
    if (minimal) {
      const minimalComments = comments.map((c: any) => ({
        id: c.id,
        created_time: c.created_time,
        author: c.created_by?.name || c.created_by?.full_name || "Unknown",
        comment: c.comment,
        // Include minimal attachment info (id, name, type) for deciding whether to fetch
        attachments: c.attachments?.map((a: any) => ({
          id: a.attachment_id,
          name: a.name,
          type: a.type,
        })) || [],
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ comments: minimalComments }, null, 2) }],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async createTaskComment(params: any) {
    const { project_id, task_id, content } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/tasks/${task_id}/comments`,
      "POST",
      { comment: content }
    );
    return {
      content: [
        {
          type: "text",
          text: `Comment added successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async updateTaskComment(params: any) {
    const { project_id, task_id, comment_id, content } = params;
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${project_id}/tasks/${task_id}/comments/${comment_id}`,
      "PATCH",
      { comment: content }
    );
    return {
      content: [
        {
          type: "text",
          text: `Comment updated successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  private async deleteTaskComment(projectId: string, taskId: string, commentId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasks/${taskId}/comments/${commentId}`,
      "DELETE"
    );
    return {
      content: [
        {
          type: "text",
          text: `Comment deleted successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  // Task Attachments
  private async listTaskAttachments(projectId: string, taskId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasks/${taskId}/attachments`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private async deleteTaskAttachment(projectId: string, taskId: string, attachmentId: string) {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}`,
      "DELETE"
    );
    return {
      content: [
        {
          type: "text",
          text: `Attachment deleted successfully:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }

  // Inline Image Download
  private async downloadInlineImage(imageUrl: string) {
    // Ensure we have a valid access token
    if (Date.now() >= this.tokenExpiresAt) {
      await this.refreshAccessToken();
    }

    if (!this.config.accessToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Zoho access token not configured."
      );
    }

    // Convert viewInlineAttachment URL to viewInlineAttachmentForApi URL
    // The ForApi endpoint accepts OAuth tokens while the regular one requires session cookies
    let apiUrl = imageUrl;
    if (imageUrl.includes('/viewInlineAttachment/')) {
      apiUrl = imageUrl.replace('/viewInlineAttachment/', '/viewInlineAttachmentForApi/');
    }

    try {
      const response = await fetch(apiUrl, {
        headers: {
          Authorization: `Zoho-oauthtoken ${this.config.accessToken}`,
        },
      });

      if (!response.ok) {
        // Try token refresh on 401
        if (response.status === 401 && this.config.refreshToken) {
          await this.refreshAccessToken();
          const retryResponse = await fetch(apiUrl, {
            headers: {
              Authorization: `Zoho-oauthtoken ${this.config.accessToken}`,
            },
          });
          if (!retryResponse.ok) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to download image after token refresh: ${retryResponse.status}`
            );
          }
          return await this.processImageResponse(retryResponse);
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to download image: ${response.status} - ${await response.text()}`
        );
      }

      return await this.processImageResponse(response);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Error downloading inline image: ${error}`
      );
    }
  }

  private async processImageResponse(response: Response) {
    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // Determine the media type for the MCP image content
    let mediaType = 'image/png';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) {
      mediaType = 'image/jpeg';
    } else if (contentType.includes('gif')) {
      mediaType = 'image/gif';
    } else if (contentType.includes('webp')) {
      mediaType = 'image/webp';
    } else if (contentType.includes('png')) {
      mediaType = 'image/png';
    }

    return {
      content: [
        {
          type: "image",
          data: base64,
          mimeType: mediaType,
        },
      ],
    };
  }

  // Comment Attachment Download
  private async downloadCommentAttachment(projectId: string, attachmentId: string) {
    // Ensure we have a valid access token
    if (Date.now() >= this.tokenExpiresAt) {
      await this.refreshAccessToken();
    }

    if (!this.config.accessToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Zoho access token not configured."
      );
    }

    try {
      // First, get attachment details to find the download URL
      const attachmentDetails = await this.makeRequest(
        `/portal/${this.config.portalId}/projects/${projectId}/attachments/${attachmentId}`
      );

      // The attachment details should contain download info
      const attachment = attachmentDetails.attachment?.[0] || attachmentDetails;

      // Try to get a download URL - Zoho provides various URL fields
      let downloadUrl = attachment.permanent_url || attachment.preview_url || attachment.download_url;

      if (!downloadUrl) {
        // If no direct URL, construct the download endpoint
        // Based on the API docs, we can use the third_party_file_id for WorkDrive files
        const thirdPartyFileId = attachment.third_party_file_id;
        if (thirdPartyFileId && attachment.app_domain === 'workdrive') {
          // For WorkDrive files, use the WorkDrive download API
          downloadUrl = `https://workdrive.zoho.com/api/v1/download/${thirdPartyFileId}`;
        } else {
          throw new McpError(
            ErrorCode.InternalError,
            `No download URL found for attachment. Details: ${JSON.stringify(attachment)}`
          );
        }
      }

      // Download the file
      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Zoho-oauthtoken ${this.config.accessToken}`,
        },
      });

      if (!response.ok) {
        // Try token refresh on 401
        if (response.status === 401 && this.config.refreshToken) {
          await this.refreshAccessToken();
          const retryResponse = await fetch(downloadUrl, {
            headers: {
              Authorization: `Zoho-oauthtoken ${this.config.accessToken}`,
            },
          });
          if (!retryResponse.ok) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to download attachment after token refresh: ${retryResponse.status}`
            );
          }
          return await this.processAttachmentResponse(retryResponse, attachment);
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to download attachment: ${response.status} - ${await response.text()}`
        );
      }

      return await this.processAttachmentResponse(response, attachment);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Error downloading comment attachment: ${error}`
      );
    }
  }

  private async processAttachmentResponse(response: Response, attachment: any) {
    const contentType = response.headers.get('content-type') || attachment.type || 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // Check if it's an image type
    if (contentType.includes('image/')) {
      let mediaType = 'image/png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) {
        mediaType = 'image/jpeg';
      } else if (contentType.includes('gif')) {
        mediaType = 'image/gif';
      } else if (contentType.includes('webp')) {
        mediaType = 'image/webp';
      } else if (contentType.includes('png')) {
        mediaType = 'image/png';
      }

      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: mediaType,
          },
        ],
      };
    }

    // For non-image files, return as text with base64 data
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            filename: attachment.name,
            type: contentType,
            size: attachment.size,
            data_base64: base64,
          }, null, 2),
        },
      ],
    };
  }

  // Feeds (activity stream)
  private async listFeeds(count: number = 20, viewkey: string = "all") {
    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/feeds?count=${count}&viewkey=${viewkey}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  // Tasks in Tasklist
  private async listTasksInTasklist(projectId: string, tasklistId: string, page: number = 1, perPage: number = 100, sortBy?: string) {
    let queryParams = `page=${page}&per_page=${perPage}`;
    if (sortBy) queryParams += `&sort_by=${encodeURIComponent(sortBy)}`;

    const data = await this.makeRequest(
      `/portal/${this.config.portalId}/projects/${projectId}/tasklists/${tasklistId}/tasks?${queryParams}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Zoho Projects MCP server running on stdio");
  }
}

const server = new ZohoProjectsServer();
server.run().catch(console.error);