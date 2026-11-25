/**
 * Observe and opt-in in-process gates.
 * Nothing here listens on a socket or spawns a process.
 */

import { Readable, Transform, Writable } from "node:stream";
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
  const stdout = new Readable({ read() {} });
  // Without a first read(), a chunk pushed before the first tick waits for it.
  // A listener added later then gets its data in the same call, as it did when
  // this was a PassThrough.
  stdout.read(0);
  let outEnded = false;
  const queued = [];
  let inboundPartial = false;
  // Set when the gate itself fails. Enforce: nothing more is forwarded, one
  // record and one policy error are written, and the streams end. Observe:
  // the bytes already went through; judging goes on for the record.
  let broken = false;

  function outOpen() {
    return !outEnded && !stdout.destroyed;
  }

  function flushErrors() {
    if (inboundPartial) return;
    while (queued.length) emitOut(queued.shift());
  }

  // A listener on stdout that throws must not make the gate write a byte twice
  // or stall. push() keeps the chunk before the listener runs, and a Readable
  // goes on delivering after the throw.
  function emitOut(raw) {
    if (!outOpen()) return;
    try {
      stdout.push(raw);
    } catch {
      if (enforce) {
        if (!broken) fault();
        endOut();
      } else {
        recordFault();
      }
    }
  }

  function endOut() {
    if (!outOpen()) return;
    outEnded = true;
    try {
      stdout.push(null);
    } catch {
      /* already closing */
    }
  }

  let recorded = false;
  function recordFault() {
    if (recorded) return;
    recorded = true;
    try {
      if (onFault) onFault();
    } catch {
      /* the record is best effort; the withhold is not */
    }
  }

  function fault() {
    broken = true;
    recordFault();
    if (enforce) {
      queued.push(
        Buffer.from(
          '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"vantio_mcp_policy_block","data":{"finding":"gate_error"}}}\n',
        ),
      );
    }
  }

  // Enforce: frames that are forwarded are written in runs, in order. Frames
  // come from the framer one at a time, so each is judged before the next is built.
  function accept(frames, onFrame, writeForward) {
    const run = [];
    let runBytes = 0;
    const flush = () => {
      if (run.length) writeForward(run.length === 1 ? run[0] : Buffer.concat(run, runBytes));
      run.length = 0;
      runBytes = 0;
    };
    for (const fr of frames) {
      if (broken) break;
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
    if (!broken) flush();
  }

  // Observe: judge for the record only. The decision does not change a byte.
  function judge(frames, onFrame) {
    for (const fr of frames) {
      try {
        onFrame(fr);
      } catch {
        recordFault();
      }
    }
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
      if (!enforce) {
        toChildWrite(chunk);
        try {
          judge(clientFramer.iterate(chunk), onClientFrame);
        } catch {
          recordFault();
        }
        cb();
        return;
      }
      if (!broken) {
        try {
          accept(clientFramer.iterate(chunk), onClientFrame, toChildWrite);
        } catch {
          fault();
        }
      }
      flushErrors();
      if (broken) endOut();
      cb();
    },
    final(cb) {
      if (!enforce) {
        try {
          judge(clientFramer.finish(), onClientFrame);
        } catch {
          recordFault();
        }
        cb();
        return;
      }
      if (!broken) {
        try {
          accept(clientFramer.finish(), onClientFrame, toChildWrite);
        } catch {
          fault();
        }
      }
      flushErrors();
      if (broken) endOut();
      cb();
    },
  });

  function onChild(chunk) {
    if (!enforce) {
      emitOut(chunk);
      try {
        judge(serverFramer.iterate(chunk), onServerFrame);
      } catch {
        recordFault();
      }
      return;
    }
    if (broken) return;
    try {
      accept(serverFramer.iterate(chunk), onServerFrame, emitOut);
    } catch {
      fault();
    }
    inboundPartial = serverFramer.buffered() > 0;
    flushErrors();
    if (broken) endOut();
  }

  let childDone = false;
  // The child's last line may have no line end. Judge it like any other, then
  // end stdout so a reader waiting for `end` is released.
  function onChildEnd() {
    if (childDone) return;
    childDone = true;
    try {
      if (enforce) {
        if (!broken) accept(serverFramer.finish(), onServerFrame, emitOut);
      } else {
        judge(serverFramer.finish(), onServerFrame);
      }
    } catch {
      if (enforce) fault();
      else recordFault();
    }
    inboundPartial = false;
    flushErrors();
    endOut();
  }

  function onChildError(err) {
    childDone = true;
    if (outOpen()) stdout.destroy(err);
  }

  fromChild.on("data", onChild);
  fromChild.on("end", onChildEnd);
  fromChild.on("close", onChildEnd);
  fromChild.on("error", onChildError);
  return {
    stdin,
    stdout,
    close() {
      fromChild.off("data", onChild);
      fromChild.off("end", onChildEnd);
      fromChild.off("close", onChildEnd);
      fromChild.off("error", onChildError);
    },
  };
}
