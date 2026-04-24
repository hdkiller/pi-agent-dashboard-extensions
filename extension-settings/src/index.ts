import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { UiField, UiSection } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "settings.json");
const EXTENSIONS_SETTINGS_KEY = "extensions:settings";

interface ExtensionSettings {
  id: string;
  title: string;
  fields: UiField[];
  sections?: UiSection[];
}

/**
 * Extension Settings Plugin (Dashboard Bridge)
 * 
 * Exposes a unified "Extension Settings" module in the pi dashboard.
 * Supports both:
 * 1. The original @axnic/pi-extension-settings protocol (pi-extension-settings:register)
 * 2. The legacy dashboard-specific protocol (extension:settings:register)
 */
export default function (pi: ExtensionAPI) {
  const registeredSettings = new Map<string, ExtensionSettings>();

  // Helper to read settings.json
  const loadValues = (): Record<string, Record<string, any>> => {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const content = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        return content[EXTENSIONS_SETTINGS_KEY] || {};
      }
    } catch (err) {
      console.error("[extension-settings] Failed to load settings:", err);
    }
    return {};
  };

  const saveValues = (values: Record<string, Record<string, any>>) => {
    try {
      let fullContent: any = {};
      if (fs.existsSync(SETTINGS_FILE)) {
        try {
          fullContent = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        } catch { /* ignore */ }
      }
      fullContent[EXTENSIONS_SETTINGS_KEY] = values;
      
      const dir = path.dirname(SETTINGS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      const tmp = SETTINGS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(fullContent, null, 2));
      fs.renameSync(tmp, SETTINGS_FILE);
    } catch (err) {
      console.error("[extension-settings] Failed to save settings:", err);
    }
  };

  // --- Registration Protocols ---

  // 1. Original @axnic Protocol
  pi.events.on("pi-extension-settings:register", (data: any) => {
    if (!data?.extension || !data?.nodes) return;
    
    // Map original nodes to UiFields
    const fields: UiField[] = [];
    const convertNode = (key: string, node: any, prefix = "") => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (node._tag === "section") {
        for (const [childKey, childNode] of Object.entries(node.children || {})) {
          convertNode(childKey, childNode, fullKey);
        }
      } else {
        fields.push({
          key: fullKey,
          label: node.label || key,
          type: node._tag === "enum" ? "select" : 
                node._tag === "number" ? "number" :
                node._tag === "boolean" ? "boolean" : "text",
          description: node.description,
          options: node.values?.map((v: string) => ({ label: v, value: v })),
          required: true
        });
      }
    };

    for (const [key, node] of Object.entries(data.nodes)) {
      convertNode(key, node);
    }

    registeredSettings.set(data.extension, {
      id: data.extension,
      title: data.extension,
      fields
    });
    
    pi.events.emit("ui:rediscover", {});
  });

  // 2. Dashboard Protocol (Legacy/Internal)
  pi.events.on("extension:settings:register", (settings: ExtensionSettings) => {
    registeredSettings.set(settings.id, settings);
    pi.events.emit("ui:rediscover", {});
  });

  // Helper for extensions to get their values
  pi.events.on("extension:settings:get", (data: { id: string, values?: any }) => {
    const allValues = loadValues();
    data.values = allValues[data.id] || {};
  });

  // --- Dashboard UI Integration ---

  pi.events.on("ui:list-modules", (data: any) => {
    if (registeredSettings.size === 0) return;

    data.modules.push({
      id: "extension-settings",
      title: "Extension Settings",
      icon: "cog",
      command: "/extension-settings",
      initialViewId: Array.from(registeredSettings.keys())[0],
      views: Array.from(registeredSettings.values()).map(settings => ({
        id: settings.id,
        title: settings.title,
        category: "Extensions",
        type: "form" as const,
        dataEvent: `extension:settings:data:${settings.id}`,
        fields: settings.fields,
        sections: settings.sections,
        actions: [
          { 
            label: "Save Settings", 
            icon: "contentSave", 
            emit: "extension:settings:save", 
            params: { id: settings.id }, 
            variant: "primary" as const 
          }
        ]
      }))
    });
  });

  pi.events.on("ui:get-data", (data: any) => {
    if (data.event?.startsWith("extension:settings:data:")) {
      const id = data.event.split(":")[3];
      if (id && registeredSettings.has(id)) {
        const allValues = loadValues();
        data.items = [allValues[id] || {}];
      }
    }
  });

  pi.events.on("extension:settings:save", (data: any) => {
    const { id, ...newValues } = data;
    if (!id) return;

    const allValues = loadValues();
    allValues[id] = { ...(allValues[id] || {}), ...newValues };
    saveValues(allValues);
    
    // Notify via both protocols
    pi.events.emit(`extension:settings:changed:${id}`, allValues[id]); // Dashboard
    pi.events.emit(`pi-extension-settings:${id}:changed`, { key: "all" }); // @axnic Protocol (simplified)
    
    pi.events.emit("flow:notify", { message: `Settings for ${id} saved.`, level: "success" });
  });

  // Broadcast ready on start so extensions can register
  pi.on("session_start", (event) => {
    if (event.reason === "startup" || event.reason === "reload") {
      pi.events.emit("pi-extension-settings:ready", {});
    }
  });
}
