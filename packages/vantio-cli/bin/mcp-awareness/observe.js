/**
 * Observe and opt-in in-process gates.
 * Nothing here listens on a socket or spawns a process.
 */

import { PassThrough, Transform, Writable } from "node:stream";
import { createFramer } from "./parse.js";

export function tapReadable(readable, onChunk, onEnd) {
  if (readable && typeof readable.getReader === "function" && typeof readable.on !== "function") {
    return { ok: false, reason: "web_stream" };
  }
  if (!readable || typeof readable.on !== "function" || typeof readable.listenerCount !== "function") {
    return { ok: false, reason: "not_flowing" };
  }
  if (readable.readableFlowing !== true || readable.listenerCount("data") < 1) {
    return { ok: false, reason: "not_flowing" };
  }
  const handler = (chunk) => {
    try {
      onChunk(chunk);
    } catch {
      onChunk(null);
    }
  };
  const ended = () => {
    try {
      if (onEnd) onEnd();
    } catch {
      /* a tap never throws into the stream */
    }
  };
  readable.on("data", handler);
  readable.on("end", ended);
  return {
    ok: true,
    close() {
      readable.off("data", handler);
      readable.off("end", ended);
    },
  };
}

export function createInProcessGate(transport, onFrame) {
  const framer = createFramer(transport);
  return new Transform({
    transform(chunk, _enc, cb) {
      deliver(framer.push(chunk), onFrame, (raw) => this.push(raw));
      cb();
    },
    flush(cb) {
      deliver(framer.finish(), onFrame, (raw) => this.push(raw));
      cb();
    },
  });
}

function deliver(frames, onFrame, push) {
  for (const fr of frames) {
    let decision;
    try {
      decision = onFrame(fr);
    } catch {
      decision = { forward: false };
    }
    if (decision && decision.forward && fr.raw && fr.raw.length) push(fr.raw);
  }
}

export function createStdioPairGate({ fromChild, toChild, onClientFrame, onServerFrame, enforce, onFault }) {
  const clientFramer = createFramer("stdio");
  const serverFramer = createFramer("stdio");
  const stdout = new PassThrough();
  const queued = [];
  let inboundPartial = false;
  // Set when the gate itself throws. Enforce: nothing more reaches the child
  // and one policy error goes back. Observe: the child's bytes pass unchanged.
  let broken = false;

  function flushErrors() {
    if (inboundPartial) return;
    while (queued.length) stdout.write(queued.shift());
  }

  function fault() {
    broken = true;
    try {
      if (onFault) onFault();
    } catch {
      /* the record is best effort; the withhold is not */
    }
    if (enforce) {
      queued.push(
        Buffer.from(
          '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"vantio_mcp_policy_block","data":{"finding":"gate_error"}}}\n',
        ),
      );
    }
  }

  // Frames that are forwarded are written in runs, in order.
  function accept(frames, onFrame, writeForward) {
    const run = [];
    let runBytes = 0;
    const flush = () => {
      if (run.length) writeForward(run.length === 1 ? run[0] : Buffer.concat(run, runBytes));
      run.length = 0;
      runBytes = 0;
    };
    for (const fr of frames) {
      let decision;
      try {
        decision = onFrame(fr);
      } catch {
        decision = { forward: false };
      }
      if (decision && decision.forward && fr.raw && fr.raw.length && writeForward) {
        run.push(fr.raw);
        runBytes += fr.raw.length;
        if (runBytes >= 65536) flush();
      }
      if (decision && decision.replacement) {
        flush();
        queued.push(decision.replacement);
      }
    }
    flush();
  }

  function toChildWrite(raw) {
    try {
      toChild.write(raw);
    } catch {
      /* the child stream is the caller's; a write failure is not a policy allow */
    }
  }

  const stdin = new Writable({
    write(chunk, _enc, cb) {
      if (broken) {
        if (!enforce) toChildWrite(chunk);
        flushErrors();
        cb();
        return;
      }
      try {
        accept(clientFramer.push(chunk), onClientFrame, toChildWrite);
      } catch {
        fault();
        if (!enforce) toChildWrite(chunk);
      }
      flushErrors();
      cb();
    },
    final(cb) {
      if (!broken) {
        try {
          accept(clientFramer.finish(), onClientFrame, toChildWrite);
        } catch {
          fault();
        }
      }
      flushErrors();
      cb();
    },
  });

  function onChild(chunk) {
    try {
      const frames = serverFramer.push(chunk);
      inboundPartial = serverFramer.buffered() > 0;
      accept(frames, onServerFrame, (raw) => stdout.write(raw));
    } catch {
      // Observe: the server's bytes go through as they came. Enforce: withheld.
      fault();
      if (!enforce) stdout.write(chunk);
    }
    inboundPartial = serverFramer.buffered() > 0;
    flushErrors();
  }

  // The child's last line may have no line end. Judge it like any other.
  function onChildEnd() {
    try {
      accept(serverFramer.finish(), onServerFrame, (raw) => stdout.write(raw));
    } catch {
      fault();
    }
    inboundPartial = false;
    flushErrors();
  }

  fromChild.on("data", onChild);
  fromChild.on("end", onChildEnd);
  return {
    stdin,
    stdout,
    close() {
      fromChild.off("data", onChild);
      fromChild.off("end", onChildEnd);
    },
  };
}
