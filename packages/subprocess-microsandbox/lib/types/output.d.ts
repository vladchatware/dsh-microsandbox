/** Bounded host-side projection of one microsandbox exec output stream. */
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess';
/**
 * Byte-faithful offset reader over one collect-mode stream. Keeps the bounded
 * TAIL in host memory and, when configured, mirrors the complete stream to a
 * host spill file up to the spill cap. Offsets are whole-stream byte
 * coordinates owned by the caller.
 */
export declare class CollectReader implements SubprocessOutputReader {
    private readonly maxBytes;
    private readonly maxSpillBytes;
    private readonly spillPath;
    private chunks;
    private retainedBytes;
    private totalBytes;
    private spillValid;
    private spillWriter;
    private finished;
    constructor(maxBytes: number, maxSpillBytes: number | undefined, spillPath: string | undefined);
    /** Total bytes observed from the exec event stream. */
    get size(): number;
    /** Append one raw output chunk from the SDK event stream. */
    push(bytes: Uint8Array): void;
    /** Mark the spill invalid (overflow or interrupted transport). */
    invalidateSpill(): void;
    /** Finish the stream: flush the spill writer and seal the reader. */
    finish(): void;
    /** @inheritdoc */
    readFrom(fromByte: number): SubprocessOutputRead;
}
//# sourceMappingURL=output.d.ts.map