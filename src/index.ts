#!/usr/bin/env bun

import { authenticate } from "@google-cloud/local-auth";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { AccountManager } from "./accounts.js";
import { formatApiError, withRetry } from "./retry.js";
import { TaskActions, TaskResources } from "./Tasks.js";

const baseDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const accountManager = new AccountManager(baseDir);

// Old single-credential path (for migration)
const oldCredentialsPath = path.join(
  baseDir,
  ".gtasks-server-credentials.json",
);

const accountParam = {
  account: {
    type: "string" as const,
    description:
      "Account name (e.g. 'personal', 'work'). Uses default account if omitted.",
  },
};

const server = new Server(
  {
    name: "example-servers/gtasks",
    version: "0.2.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const tasksClient = accountManager.getTasksClient();
  const [allTasks, nextPageToken] = await TaskResources.list(
    request,
    tasksClient,
  );
  return {
    resources: allTasks.map((task) => ({
      uri: `gtasks:///${task.id}`,
      mimeType: "text/plain",
      name: task.title,
    })),
    nextCursor: nextPageToken,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const tasksClient = accountManager.getTasksClient();
  const task = await TaskResources.read(request, tasksClient);

  const lines: string[] = [];
  lines.push(`Title: ${task.title || "No title"}`);
  lines.push(`Status: ${task.status || "Unknown"}`);
  if (task.due) lines.push(`Due: ${task.due}`);
  if (task.notes) lines.push(`Notes: ${task.notes}`);
  if (task.completed) lines.push(`Completed: ${task.completed}`);
  if (task.parent) lines.push(`Parent: ${task.parent}`);
  if (task.updated) lines.push(`Updated: ${task.updated}`);

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "text/plain",
        text: lines.join("\n"),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search for a task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
            ...accountParam,
          },
          required: ["query"],
        },
      },
      {
        name: "list",
        description: "List all tasks in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            cursor: {
              type: "string",
              description: "Cursor for pagination",
            },
            ...accountParam,
          },
        },
      },
      {
        name: "create",
        description: "Create a new task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
            title: {
              type: "string",
              description: "Task title",
            },
            notes: {
              type: "string",
              description: "Task notes",
            },
            due: {
              type: "string",
              description:
                "Due date (YYYY-MM-DD or ISO 8601 format, e.g. 2025-03-19)",
            },
            ...accountParam,
          },
          required: ["title"],
        },
      },
      {
        name: "clear",
        description: "Clear completed tasks from a Google Tasks task list",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
            ...accountParam,
          },
          required: ["taskListId"],
        },
      },
      {
        name: "delete",
        description: "Delete a task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
            id: {
              type: "string",
              description: "Task id",
            },
            ...accountParam,
          },
          required: ["id", "taskListId"],
        },
      },
      {
        name: "list-tasklists",
        description: "List all task lists in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            ...accountParam,
          },
        },
      },
      {
        name: "update",
        description: "Update a task in Google Tasks",
        inputSchema: {
          type: "object",
          properties: {
            taskListId: {
              type: "string",
              description: "Task list ID",
            },
            id: {
              type: "string",
              description: "Task ID",
            },
            uri: {
              type: "string",
              description: "Task URI",
            },
            title: {
              type: "string",
              description: "Task title",
            },
            notes: {
              type: "string",
              description: "Task notes",
            },
            status: {
              type: "string",
              enum: ["needsAction", "completed"],
              description: "Task status (needsAction or completed)",
            },
            due: {
              type: "string",
              description:
                "Due date (YYYY-MM-DD or ISO 8601 format, e.g. 2025-03-19)",
            },
            ...accountParam,
          },
          required: ["id"],
        },
      },
      {
        name: "list-accounts",
        description:
          "List all authenticated Google accounts and show which is the default",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "set-default-account",
        description: "Change the default Google account used when no account is specified",
        inputSchema: {
          type: "object",
          properties: {
            account: {
              type: "string",
              description: "Account name to set as default",
            },
          },
          required: ["account"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments;

  // Account management tools don't need Google API access
  if (request.params.name === "list-accounts") {
    const accounts = accountManager.listAccounts();
    if (accounts.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No accounts found. Run 'bun run start auth <account-name>' to add one.",
          },
        ],
      };
    }
    const defaultAccount = accountManager.getDefaultAccount();
    const formatted = accounts
      .map((a) => `${a}${a === defaultAccount ? " (default)" : ""}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Authenticated accounts:\n${formatted}`,
        },
      ],
    };
  }

  if (request.params.name === "set-default-account") {
    const account = args?.account as string;
    if (!account) {
      throw new Error("Account name is required");
    }
    accountManager.setDefaultAccount(account);
    return {
      content: [
        {
          type: "text",
          text: `Default account set to: ${account}`,
        },
      ],
    };
  }

  // All other tools use an account-specific Tasks client
  const accountName = accountManager.resolveAccount(args);
  let tasksClient: ReturnType<typeof accountManager.getTasksClient>;
  try {
    tasksClient = accountManager.getTasksClient(accountName);
  } catch (error: any) {
    return formatApiError(error, accountName);
  }

  try {
    if (request.params.name === "search") {
      return await TaskActions.search(request, tasksClient);
    }
    if (request.params.name === "list") {
      return await TaskActions.list(request, tasksClient);
    }
    if (request.params.name === "list-tasklists") {
      const response = await withRetry(
        () => tasksClient.tasklists.list(),
        "tasklists.list",
      );
      const taskLists = response.data.items || [];
      const formatted = taskLists
        .map((list) => `${list.title} (ID: ${list.id})`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              taskLists.length > 0
                ? `Found ${taskLists.length} task lists (account: ${accountName}):\n${formatted}`
                : `No task lists found (account: ${accountName})`,
          },
        ],
      };
    }
    if (request.params.name === "create") {
      return await TaskActions.create(request, tasksClient);
    }
    if (request.params.name === "update") {
      return await TaskActions.update(request, tasksClient);
    }
    if (request.params.name === "delete") {
      return await TaskActions.delete(request, tasksClient);
    }
    if (request.params.name === "clear") {
      return await TaskActions.clear(request, tasksClient);
    }
    throw new Error("Tool not found");
  } catch (error: any) {
    // Input validation errors (thrown by our code) pass through as-is
    if (!error?.code && !error?.response?.status) {
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
    // Google API errors get formatted with guidance
    return formatApiError(error, accountName);
  }
});

async function authenticateAndSaveCredentials(accountName: string) {
  console.log(`Authenticating account "${accountName}"…`);
  const auth = await authenticate({
    keyfilePath: accountManager.getOAuthKeysPath(),
    scopes: ["https://www.googleapis.com/auth/tasks"],
  });
  accountManager.saveCredentials(accountName, auth.credentials);
  console.log(
    `Credentials saved for account "${accountName}". You can now run the server.`,
  );
}

async function loadAndRunServer() {
  // Migrate old credentials if needed
  accountManager.migrateOldCredentials(oldCredentialsPath);

  const accounts = accountManager.listAccounts();
  if (accounts.length === 0) {
    console.error(
      "No accounts found. Run 'bun run start auth <account-name>' to add one.",
    );
    process.exit(1);
  }

  console.error(
    `Loaded ${accounts.length} account(s): ${accounts.join(", ")}. Default: ${accountManager.getDefaultAccount()}`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[2] === "auth") {
  const accountName = process.argv[3];
  if (!accountName) {
    console.error(
      "Usage: bun run start auth <account-name>\nExample: bun run start auth personal",
    );
    process.exit(1);
  }
  authenticateAndSaveCredentials(accountName).catch(console.error);
} else {
  loadAndRunServer().catch(console.error);
}
