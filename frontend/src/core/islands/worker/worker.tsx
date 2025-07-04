/* Copyright 2024 Marimo. All rights reserved. */

import type { PyodideInterface } from "pyodide";
import {
  createRPC,
  createRPCRequestHandler,
  createWorkerParentTransport,
  type RPCSchema,
} from "rpc-anywhere";
import type { OperationMessage } from "@/core/kernel/messages";
import type { ParentSchema } from "@/core/wasm/rpc";
import { TRANSPORT_ID } from "@/core/wasm/worker/constants";
import { getPyodideVersion } from "@/core/wasm/worker/getPyodideVersion";
import { MessageBuffer } from "@/core/wasm/worker/message-buffer";
import type { RawBridge, SerializedBridge } from "@/core/wasm/worker/types";
import type { JsonString } from "@/utils/json/base64";
import { Logger } from "@/utils/Logger";
import { Deferred } from "../../../utils/Deferred";
import { prettyError } from "../../../utils/errors";
import { invariant } from "../../../utils/invariant";
import { ReadonlyWasmController } from "./controller";

declare const self: Window & {
  pyodide: PyodideInterface;
  controller: ReadonlyWasmController;
};

// Initialize pyodide
async function loadPyodideAndPackages() {
  const marimoVersion = getMarimoVersion();
  const pyodideVersion = getPyodideVersion(marimoVersion);
  try {
    self.controller = new ReadonlyWasmController();
    self.pyodide = await self.controller.bootstrap({
      version: marimoVersion,
      pyodideVersion: pyodideVersion,
    });
  } catch (error) {
    Logger.error("Error bootstrapping", error);
    rpc.send.initializedError({
      error: prettyError(error),
    });
  }
}

const pyodideReadyPromise = loadPyodideAndPackages();
const messageBuffer = new MessageBuffer(
  (message: JsonString<OperationMessage>) => {
    rpc.send.kernelMessage({ message });
  },
);
const bridgeReady = new Deferred<SerializedBridge>();

// Handle RPC requests
const requestHandler = createRPCRequestHandler({
  /**
   * Start the session
   */
  startSession: async (opts: { code: string; appId: string }) => {
    await pyodideReadyPromise; // Make sure loading is done

    try {
      invariant(self.controller, "Controller not loaded");
      const notebook = await self.controller.mountFilesystem({
        code: opts.code,
        filename: `app-${opts.appId}.py`,
      });
      const bridge = await self.controller.startSession({
        ...notebook,
        onMessage: messageBuffer.push,
      });
      bridgeReady.resolve(bridge);
      rpc.send.initialized({});
    } catch (error) {
      rpc.send.initializedError({
        error: prettyError(error),
      });
    }
    return;
  },

  /**
   * Load packages
   */
  loadPackages: async (code: string) => {
    await pyodideReadyPromise; // Make sure loading is done

    if (code.includes("mo.sql")) {
      // Add pandas and duckdb to the code
      code = `import pandas\n${code}`;
      code = `import duckdb\n${code}`;
      code = `import sqlglot\n${code}`;

      // Polars + SQL requires pyarrow, and installing
      // after notebook load does not work. As a heuristic,
      // if it appears that the notebook uses polars, add pyarrow.
      if (code.includes("polars")) {
        code = `import pyarrow\n${code}`;
      }
    }

    await self.pyodide.loadPackagesFromImports(code, {
      messageCallback: Logger.log,
      errorCallback: Logger.error,
    });
  },

  /**
   * Call a function on the bridge
   */
  bridge: async (opts: {
    functionName: keyof RawBridge;
    payload: {} | undefined | null;
  }) => {
    await pyodideReadyPromise; // Make sure loading is done

    const { functionName, payload } = opts;

    // Perform the function call to the Python bridge
    const bridge = await bridgeReady.promise;

    // Serialize the payload
    const payloadString =
      payload == null
        ? null
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload);

    // Make the request
    const response =
      payloadString == null
        ? // @ts-expect-error ehh TypeScript
          await bridge[functionName]()
        : // @ts-expect-error ehh TypeScript
          await bridge[functionName](payloadString);

    // Post the response back to the main thread
    return typeof response === "string" ? JSON.parse(response) : response;
  },
});

// create the iframe's schema
export type WorkerSchema = RPCSchema<
  {
    messages: {
      // Emitted when the worker is ready
      ready: {};
      // Emitted when the kernel sends a message
      kernelMessage: { message: JsonString<OperationMessage> };
      // Emitted when the Pyodide is initialized
      initialized: {};
      // Emitted when the Pyodide fails to initialize
      initializedError: { error: string };
    };
  },
  typeof requestHandler
>;

const rpc = createRPC<WorkerSchema, ParentSchema>({
  transport: createWorkerParentTransport({
    transportId: TRANSPORT_ID,
  }),
  requestHandler,
});

rpc.send("ready", {});

/// Listeners
// When the consumer is ready, start the message buffer
rpc.addMessageListener("consumerReady", async () => {
  await pyodideReadyPromise; // Make sure loading is done
  messageBuffer.start();
});

function getMarimoVersion() {
  return self.name; // We store the version in the worker name
}
