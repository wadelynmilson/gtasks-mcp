import {
  CallToolRequest,
  ListResourcesRequest,
  ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { tasks_v1 } from "googleapis";
import { withRetry } from "./retry.js";

const MAX_TASK_RESULTS = 100;
const VALID_STATUSES = ["needsAction", "completed"];

/**
 * Normalize a due date string to RFC 3339 format expected by Google Tasks API.
 * Google Tasks only stores the date portion, so time is set to midnight UTC.
 * Accepts: "2025-03-19", "2025-03-19T21:00:00", "2025-03-19T21:00:00Z", etc.
 */
export function normalizeDueDate(due: string | undefined): string | undefined {
  if (!due) return undefined;
  const parsed = new Date(due);
  if (isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid due date: "${due}". Use YYYY-MM-DD format (e.g. 2026-03-27).`,
    );
  }
  // Google Tasks only uses the date portion, so normalize to midnight UTC
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00.000Z`;
}

export class TaskResources {
  static async read(request: ReadResourceRequest, tasks: tasks_v1.Tasks) {
    const taskId = request.params.uri.replace("gtasks:///", "");

    const taskListsResponse = await withRetry(
      () => tasks.tasklists.list({ maxResults: MAX_TASK_RESULTS }),
      "tasklists.list",
    );

    const taskLists = taskListsResponse.data.items || [];
    let task: tasks_v1.Schema$Task | null = null;

    for (const taskList of taskLists) {
      if (taskList.id) {
        try {
          const taskResponse = await withRetry(
            () => tasks.tasks.get({ tasklist: taskList.id!, task: taskId }),
            "tasks.get",
          );
          task = taskResponse.data;
          break;
        } catch (error) {
          // Task not found in this list, continue to the next one
        }
      }
    }

    if (!task) {
      throw new Error("Task not found");
    }

    return task;
  }

  static async list(
    request: ListResourcesRequest,
    tasks: tasks_v1.Tasks,
  ): Promise<[tasks_v1.Schema$Task[], string | null]> {
    const pageSize = 10;
    const params: any = {
      maxResults: pageSize,
    };

    if (request.params?.cursor) {
      params.pageToken = request.params.cursor;
    }

    const taskListsResponse = await withRetry(
      () => tasks.tasklists.list({ maxResults: MAX_TASK_RESULTS }),
      "tasklists.list",
    );

    const taskLists = taskListsResponse.data.items || [];

    let allTasks: tasks_v1.Schema$Task[] = [];
    let nextPageToken = null;

    for (const taskList of taskLists) {
      const tasksResponse = await withRetry(
        () => tasks.tasks.list({ tasklist: taskList.id, ...params }),
        "tasks.list",
      );

      const taskItems = tasksResponse.data.items || [];
      allTasks = allTasks.concat(taskItems);

      if (tasksResponse.data.nextPageToken) {
        nextPageToken = tasksResponse.data.nextPageToken;
      }
    }

    return [allTasks, nextPageToken];
  }
}

export class TaskActions {
  private static formatTask(
    task: tasks_v1.Schema$Task & { taskListName?: string },
  ) {
    const lines: string[] = [];
    lines.push(`- **${task.title || "(untitled)"}**`);
    lines.push(`  ID: ${task.id}`);
    lines.push(`  Status: ${task.status}`);
    if (task.taskListName) lines.push(`  List: ${task.taskListName}`);
    if (task.due) lines.push(`  Due: ${task.due}`);
    if (task.notes) lines.push(`  Notes: ${task.notes}`);
    if (task.completed) lines.push(`  Completed: ${task.completed}`);
    if (task.parent) lines.push(`  Parent: ${task.parent}`);
    if (task.links && Array.isArray(task.links) && task.links.length > 0) {
      const linkStrs = task.links
        .map((l: any) => l.link || l.description || "")
        .filter(Boolean);
      if (linkStrs.length > 0)
        lines.push(`  Links: ${linkStrs.join(", ")}`);
    }
    return lines.join("\n");
  }

  private static formatTaskList(taskList: tasks_v1.Schema$Task[]) {
    return taskList.map((task) => this.formatTask(task)).join("\n\n");
  }

  private static async _list(
    request: CallToolRequest,
    tasks: tasks_v1.Tasks,
  ) {
    const taskListsResponse = await withRetry(
      () => tasks.tasklists.list({ maxResults: MAX_TASK_RESULTS }),
      "tasklists.list",
    );

    const taskLists = taskListsResponse.data.items || [];
    let allTasks: (tasks_v1.Schema$Task & { taskListName?: string })[] = [];

    for (const taskList of taskLists) {
      if (taskList.id) {
        try {
          const tasksResponse = await withRetry(
            () =>
              tasks.tasks.list({
                tasklist: taskList.id!,
                maxResults: MAX_TASK_RESULTS,
              }),
            "tasks.list",
          );

          const items = (tasksResponse.data.items || []).map((item) => ({
            ...item,
            taskListName: taskList.title || taskList.id || undefined,
          }));
          allTasks = allTasks.concat(items);
        } catch (error) {
          console.error(
            `Error fetching tasks for list ${taskList.id}:`,
            error,
          );
        }
      }
    }
    return allTasks;
  }

  static async create(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";
    const taskTitle = request.params.arguments?.title as string;
    const taskNotes = request.params.arguments?.notes as string;
    const taskDue = request.params.arguments?.due as string;

    if (!taskTitle || !taskTitle.trim()) {
      throw new Error("Task title is required.");
    }

    const task: Record<string, string> = {
      title: taskTitle,
    };
    if (taskNotes) task.notes = taskNotes;
    if (taskDue) task.due = normalizeDueDate(taskDue)!;

    const taskResponse = await withRetry(
      () => tasks.tasks.insert({ tasklist: taskListId, requestBody: task }),
      "tasks.insert",
    );

    return {
      content: [
        {
          type: "text",
          text: `Task created: ${taskResponse.data.title}`,
        },
      ],
      isError: false,
    };
  }

  static async update(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";
    const taskId = request.params.arguments?.id as string;
    const taskTitle = request.params.arguments?.title as string;
    const taskNotes = request.params.arguments?.notes as string;
    const taskStatus = request.params.arguments?.status as string;
    const taskDue = request.params.arguments?.due as string;

    if (!taskId) {
      throw new Error(
        "Task ID is required. Use the 'list' tool to find task IDs.",
      );
    }

    if (taskStatus && !VALID_STATUSES.includes(taskStatus)) {
      throw new Error(
        `Invalid status "${taskStatus}". Must be "needsAction" or "completed".`,
      );
    }

    const task: Record<string, string> = {
      id: taskId,
    };
    if (taskTitle) task.title = taskTitle;
    if (taskNotes) task.notes = taskNotes;
    if (taskStatus) task.status = taskStatus;
    if (taskDue) task.due = normalizeDueDate(taskDue)!;

    const taskResponse = await withRetry(
      () =>
        tasks.tasks.patch({
          tasklist: taskListId,
          task: taskId,
          requestBody: task,
        }),
      "tasks.patch",
    );

    return {
      content: [
        {
          type: "text",
          text: `Task updated: ${taskResponse.data.title}`,
        },
      ],
      isError: false,
    };
  }

  static async list(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const allTasks = await this._list(request, tasks);
    const taskList = this.formatTaskList(allTasks);

    return {
      content: [
        {
          type: "text",
          text: `Found ${allTasks.length} tasks:\n${taskList}`,
        },
      ],
      isError: false,
    };
  }

  static async delete(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";
    const taskId = request.params.arguments?.id as string;

    if (!taskId) {
      throw new Error(
        "Task ID is required. Use the 'list' tool to find task IDs.",
      );
    }

    if (!taskListId) {
      throw new Error(
        "Task list ID is required. Use the 'list-tasklists' tool to find task list IDs.",
      );
    }

    await withRetry(
      () => tasks.tasks.delete({ tasklist: taskListId, task: taskId }),
      "tasks.delete",
    );

    return {
      content: [
        {
          type: "text",
          text: `Task ${taskId} deleted`,
        },
      ],
      isError: false,
    };
  }

  static async search(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const userQuery = request.params.arguments?.query as string;

    if (!userQuery || !userQuery.trim()) {
      throw new Error("Search query is required.");
    }

    const allTasks = await this._list(request, tasks);
    const filteredItems = allTasks.filter(
      (task) =>
        task.title?.toLowerCase().includes(userQuery.toLowerCase()) ||
        task.notes?.toLowerCase().includes(userQuery.toLowerCase()),
    );

    const taskList = this.formatTaskList(filteredItems);

    return {
      content: [
        {
          type: "text",
          text: `Found ${filteredItems.length} tasks matching "${userQuery}":\n\n${taskList}`,
        },
      ],
      isError: false,
    };
  }

  static async clear(request: CallToolRequest, tasks: tasks_v1.Tasks) {
    const taskListId =
      (request.params.arguments?.taskListId as string) || "@default";

    if (!taskListId) {
      throw new Error(
        "Task list ID is required. Use the 'list-tasklists' tool to find task list IDs.",
      );
    }

    await withRetry(
      () => tasks.tasks.clear({ tasklist: taskListId }),
      "tasks.clear",
    );

    return {
      content: [
        {
          type: "text",
          text: `Tasks from tasklist ${taskListId} cleared`,
        },
      ],
      isError: false,
    };
  }
}
