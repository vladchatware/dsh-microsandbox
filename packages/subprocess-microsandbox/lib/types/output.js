/** Bounded host-side projection of one microsandbox exec output stream. */
import { Buffer } from 'node:buffer';
import { createWriteStream, unlinkSync } from 'node:fs';
/**
 * Byte-faithful offset reader over one collect-mode stream. Keeps the bounded
 * TAIL in host memory and, when configured, mirrors the complete stream to a
 * host spill file up to the spill cap. Offsets are whole-stream byte
 * coordinates owned by the caller.
 */
export class CollectReader {
    maxBytes;
    maxSpillBytes;
    spillPath;
    chunks = [];
    retainedBytes = 0;
    totalBytes = 0;
    spillValid = false;
    spillWriter;
    finished = false;
    constructor(maxBytes, maxSpillBytes, spillPath) {
        this.maxBytes = maxBytes;
        this.maxSpillBytes = maxSpillBytes;
        this.spillPath = spillPath;
        if (spillPath !== undefined && maxSpillBytes !== undefined) {
            // 'wx' refuses to follow or clobber a pre-existing file at a guessable path.
            this.spillWriter = createWriteStream(spillPath, { flags: 'wx' });
            this.spillValid = true;
        }
    }
    /** Total bytes observed from the exec event stream. */
    get size() {
        return this.totalBytes;
    }
    /** Append one raw output chunk from the SDK event stream. */
    push(bytes) {
        if (bytes.length === 0)
            return;
        const chunk = Buffer.from(bytes);
        this.totalBytes += chunk.length;
        this.chunks.push(chunk);
        this.retainedBytes += chunk.length;
        while (this.retainedBytes > this.maxBytes) {
            const head = this.chunks[0];
            const excess = this.retainedBytes - this.maxBytes;
            if (head.length <= excess) {
                this.chunks.shift();
                this.retainedBytes -= head.length;
            }
            else {
                this.chunks[0] = head.subarray(excess);
                this.retainedBytes -= excess;
            }
        }
        if (this.spillWriter !== undefined && this.spillValid) {
            const cap = this.maxSpillBytes;
            if (cap !== undefined && this.totalBytes <= cap) {
                this.spillWriter.write(chunk);
            }
            else {
                // A stream past the spill cap discards its now-incomplete spill.
                this.invalidateSpill();
            }
        }
    }
    /** Mark the spill invalid (overflow or interrupted transport). */
    invalidateSpill() {
        if (this.spillWriter !== undefined) {
            this.spillWriter.destroy();
            this.spillWriter = undefined;
        }
        if (this.spillPath !== undefined) {
            try {
                unlinkSync(this.spillPath);
            }
            catch {
                // The spill file may never have been created or already removed.
            }
        }
        this.spillValid = false;
    }
    /** Finish the stream: flush the spill writer and seal the reader. */
    finish() {
        if (this.finished)
            return;
        this.finished = true;
        if (this.spillWriter !== undefined) {
            this.spillWriter.end();
            this.spillWriter = undefined;
        }
    }
    /** @inheritdoc */
    readFrom(fromByte) {
        const retained = Buffer.concat(this.chunks, this.retainedBytes);
        const firstRetained = this.totalBytes - this.retainedBytes;
        const lossy = fromByte < firstRetained;
        const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained));
        return {
            text: retained.subarray(start).toString('utf8'),
            nextOffset: this.totalBytes,
            lossy,
            ...(lossy && this.spillValid && this.maxSpillBytes !== undefined && this.totalBytes <= this.maxSpillBytes
                ? { spillPath: this.spillPath }
                : {}),
        };
    }
}
//# sourceMappingURL=output.js.map