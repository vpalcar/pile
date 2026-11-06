import { memo, useMemo } from "react";
import DOMPurify from "dompurify";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer");
  }
});

/** GitHub-rendered markdown (body_html), sanitized again before it touches the DOM. */
export const Markdown = memo(function Markdown({ html, className = "" }: { html: string | null; className?: string }) {
  const clean = useMemo(
    () => (html ? DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form"] }) : ""),
    [html],
  );
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: clean }} />;
});
