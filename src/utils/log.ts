import { config } from "../../package.json";

export function log(message: string): void {
  Zotero.debug(`[${config.addonName}] ${message}`);
}
