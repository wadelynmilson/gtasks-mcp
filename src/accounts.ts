import fs from "fs";
import path from "path";
import { google, tasks_v1 } from "googleapis";

export class AccountManager {
  private credentialsDir: string;
  private configPath: string;
  private oauthKeysPath: string;
  private clients: Map<string, tasks_v1.Tasks> = new Map();
  private defaultAccount: string | null = null;

  constructor(baseDir: string) {
    this.credentialsDir = path.join(baseDir, ".gtasks-credentials");
    this.configPath = path.join(this.credentialsDir, "_config.json");
    this.oauthKeysPath = path.join(baseDir, "gcp-oauth.keys.json");
  }

  /** Ensure the credentials directory exists */
  ensureDir() {
    if (!fs.existsSync(this.credentialsDir)) {
      fs.mkdirSync(this.credentialsDir, { recursive: true });
    }
  }

  /** Migrate old single-file credentials to the new directory structure */
  migrateOldCredentials(oldCredentialsPath: string) {
    if (
      fs.existsSync(oldCredentialsPath) &&
      !fs.existsSync(this.credentialsDir)
    ) {
      this.ensureDir();
      const dest = path.join(this.credentialsDir, "default.json");
      fs.copyFileSync(oldCredentialsPath, dest);
      console.error(
        `Migrated existing credentials to ${dest}. You can remove the old file: ${oldCredentialsPath}`,
      );
    }
  }

  /** Load OAuth app keys (shared across all accounts) */
  private loadOAuthKeys() {
    const keysContent = JSON.parse(
      fs.readFileSync(this.oauthKeysPath, "utf-8"),
    );
    const keys = keysContent.installed || keysContent.web;
    if (!keys) {
      throw new Error(
        "Invalid OAuth keys file — expected 'installed' or 'web' key",
      );
    }
    return keys;
  }

  /** Get the credential file path for an account */
  credentialPath(accountName: string): string {
    return path.join(this.credentialsDir, `${accountName}.json`);
  }

  /** Save credentials for an account */
  saveCredentials(accountName: string, credentials: any) {
    this.ensureDir();
    fs.writeFileSync(
      this.credentialPath(accountName),
      JSON.stringify(credentials),
    );
  }

  /** List all authed account names */
  listAccounts(): string[] {
    if (!fs.existsSync(this.credentialsDir)) return [];
    return fs
      .readdirSync(this.credentialsDir)
      .filter((f) => f.endsWith(".json") && f !== "_config.json")
      .map((f) => f.replace(".json", ""))
      .sort();
  }

  /** Get the default account name */
  getDefaultAccount(): string {
    if (this.defaultAccount) return this.defaultAccount;

    // Check config file
    if (fs.existsSync(this.configPath)) {
      const config = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      if (config.defaultAccount) {
        this.defaultAccount = config.defaultAccount;
        return this.defaultAccount;
      }
    }

    // Fall back to first account alphabetically
    const accounts = this.listAccounts();
    if (accounts.length === 0) {
      throw new Error(
        "No accounts found. Run 'bun run start auth <account-name>' to add one.",
      );
    }
    return accounts[0];
  }

  /** Set the default account */
  setDefaultAccount(accountName: string) {
    const accounts = this.listAccounts();
    if (!accounts.includes(accountName)) {
      throw new Error(
        `Account "${accountName}" not found. Available: ${accounts.join(", ")}`,
      );
    }
    this.ensureDir();
    fs.writeFileSync(
      this.configPath,
      JSON.stringify({ defaultAccount: accountName }),
    );
    this.defaultAccount = accountName;
  }

  /** Get a Tasks API client for a specific account (or default) */
  getTasksClient(accountName?: string): tasks_v1.Tasks {
    const name = accountName || this.getDefaultAccount();
    const cached = this.clients.get(name);
    if (cached) return cached;

    const credPath = this.credentialPath(name);
    if (!fs.existsSync(credPath)) {
      throw new Error(
        `Account "${name}" not found. Run 'bun run start auth ${name}' to set it up.`,
      );
    }

    const keys = this.loadOAuthKeys();
    const credentials = JSON.parse(fs.readFileSync(credPath, "utf-8"));

    const auth = new google.auth.OAuth2(
      keys.client_id,
      keys.client_secret,
      keys.redirect_uris?.[0],
    );
    auth.setCredentials(credentials);

    // Auto-save refreshed tokens
    auth.on("tokens", (newTokens) => {
      const existing = JSON.parse(fs.readFileSync(credPath, "utf-8"));
      const merged = { ...existing, ...newTokens };
      fs.writeFileSync(credPath, JSON.stringify(merged));
    });

    const tasksClient = google.tasks({ version: "v1", auth });
    this.clients.set(name, tasksClient);
    return tasksClient;
  }

  /** Resolve account name from tool arguments, falling back to default */
  resolveAccount(args: Record<string, unknown> | undefined): string {
    return (args?.account as string) || this.getDefaultAccount();
  }

  /** Get the OAuth keys path (for auth flow) */
  getOAuthKeysPath(): string {
    return this.oauthKeysPath;
  }
}
