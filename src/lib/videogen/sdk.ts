/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The paid-API SDKs (@google/genai, @runwayml/sdk) are loaded only when a paid call is made. A PC
 * where `npm install` has not fetched them yet still typechecks, starts the server and runs every
 * local feature; only the paid call says what to install.
 */
export interface GenAIClient {
  models: any;
  operations: any;
  files: any;
}
export interface RunwayClient {
  imageToVideo: any;
}

async function optionalImport<T>(name: string, what: string): Promise<T> {
  // A plain string variable: TypeScript does not resolve it, so a missing package is no build error.
  const spec: string = name;
  try {
    return (await import(spec)) as T;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") throw new Error(`${what} needs the package ${name}: run "npm install" in the ClipForge folder (npm.cmd install in PowerShell).`);
    throw err;
  }
}

export async function genAIClient(apiKey: string): Promise<GenAIClient> {
  const m = await optionalImport<{ GoogleGenAI: new (o: { apiKey: string }) => GenAIClient }>("@google/genai", "Gemini / Veo");
  return new m.GoogleGenAI({ apiKey });
}

export async function runwayClient(apiKey: string): Promise<RunwayClient> {
  const m = await optionalImport<{ default: new (o: { apiKey: string }) => RunwayClient }>("@runwayml/sdk", "Runway");
  return new m.default({ apiKey });
}
