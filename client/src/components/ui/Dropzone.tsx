import { useCallback, useRef, useState } from "react";
import { UploadCloud, X, FileVideo, ImageIcon } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";

interface DropzoneProps {
  kind: "video" | "image";
  file: File | null;
  onSelect: (file: File | null) => void;
  label: string;
  hint: string;
  optional?: boolean;
  disabled?: boolean;
}

const ACCEPT = {
  video: "video/mp4,video/quicktime,video/webm,video/x-matroska",
  image: "image/jpeg,image/png,image/webp",
} as const;

export function Dropzone({
  kind,
  file,
  onSelect,
  label,
  hint,
  optional,
  disabled,
}: DropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = ACCEPT[kind];

  const take = useCallback(
    (next: File | null) => {
      // Object URLs are not garbage collected on their own; the previous one
      // must be released or every re-selection leaks a blob.
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return next ? URL.createObjectURL(next) : null;
      });
      onSelect(next);
    },
    [onSelect],
  );

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;

    const dropped = event.dataTransfer.files?.[0];
    if (!dropped) return;

    // Browsers report an empty type for some files; accept those and let the
    // server's mime check be the authority rather than blocking here.
    if (dropped.type && !accept.includes(dropped.type)) return;
    take(dropped);
  };

  const Icon = kind === "video" ? FileVideo : ImageIcon;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <label className="text-[13px] font-medium text-ink">{label}</label>
        {optional && <span className="text-[11px] text-ink-faint">optional</span>}
      </div>

      {file ? (
        <div className="relative overflow-hidden rounded-xl border border-line bg-surface-2">
          {kind === "video" && preview ? (
            <video
              src={preview}
              className="h-28 w-full bg-black object-contain"
              muted
              playsInline
            />
          ) : preview ? (
            <img src={preview} alt="" className="h-28 w-full bg-black object-contain" />
          ) : null}

          <div className="flex items-center gap-2 px-3 py-2">
            <Icon size={14} className="shrink-0 text-accent" />
            <span className="truncate text-xs text-ink-dim" title={file.name}>
              {file.name}
            </span>
            <span className="tnum ml-auto shrink-0 text-[11px] text-ink-faint">
              {formatBytes(file.size)}
            </span>
          </div>

          {!disabled && (
            <button
              type="button"
              onClick={() => take(null)}
              aria-label={`Remove ${label}`}
              className="absolute right-2 top-2 grid size-6 place-items-center rounded-md bg-black/70 text-ink-dim backdrop-blur transition hover:bg-black/90 hover:text-ink"
            >
              <X size={13} />
            </button>
          )}
        </div>
      ) : (
        <div
          className={cn(
            "dropzone grid cursor-pointer place-items-center px-4 py-6 text-center",
            disabled && "pointer-events-none opacity-50",
          )}
          data-active={dragging}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={disabled ? -1 : 0}
        >
          <UploadCloud size={20} className="mb-2 text-ink-faint" />
          <p className="text-xs font-medium text-ink-dim">
            Drop {kind === "video" ? "a video" : "an image"} or click
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(e) => take(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}
