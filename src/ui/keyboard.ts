import { encodeCallback } from "@/utils/callback";

export function kb(rows: Array<Array<{ text: string; action: string; payload?: Record<string, string | number | undefined> }>>) {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: encodeCallback(button.action, button.payload)
      }))
    )
  };
}
