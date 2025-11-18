import { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cn } from "../../lib/utils.ts";

export interface DropdownItem {
  label: string;
  onClick: (e?: Event) => void;
  icon?: ComponentChildren;
  danger?: boolean;
  disabled?: boolean;
}

export interface DropdownDivider {
  type: "divider";
}

export type DropdownMenuItem = DropdownItem | DropdownDivider;

export interface DropdownProps {
  trigger: ComponentChildren;
  items: DropdownMenuItem[];
  position?: "left" | "right";
  class?: string;
}

export function Dropdown({
  trigger,
  items,
  position = "right",
  class: className,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const menuItems = dropdownRef.current?.querySelectorAll(
      '[role="menuitem"]:not([disabled])',
    );
    if (!menuItems || menuItems.length === 0) return;

    let currentIndex = 0;

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          currentIndex = (currentIndex + 1) % menuItems.length;
          (menuItems[currentIndex] as HTMLElement).focus();
          break;
        case "ArrowUp":
          event.preventDefault();
          currentIndex =
            (currentIndex - 1 + menuItems.length) % menuItems.length;
          (menuItems[currentIndex] as HTMLElement).focus();
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          (menuItems[currentIndex] as HTMLElement).click();
          break;
      }
    };

    dropdownRef.current?.addEventListener("keydown", handleKeyDown);

    return () => {
      dropdownRef.current?.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={dropdownRef} class={cn("relative", className)}>
      {/* Trigger */}
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>

      {/* Menu */}
      {isOpen && (
        <div
          class={cn(
            "absolute top-full mt-2 py-1 bg-dark-850 border border-dark-700 rounded-lg shadow-xl z-50 min-w-[200px] animate-slideIn",
            position === "right" ? "right-0" : "left-0",
          )}
          role="menu"
        >
          {items.map((item, index) => {
            if ("type" in item && item.type === "divider") {
              return (
                <div
                  key={`divider-${index}`}
                  class="h-px bg-dark-700 my-1"
                />
              );
            }

            const menuItem = item as DropdownItem;

            return (
              <button
                key={index}
                role="menuitem"
                disabled={menuItem.disabled}
                onClick={(e) => {
                  if (!menuItem.disabled) {
                    menuItem.onClick(e);
                    setIsOpen(false);
                  }
                }}
                class={cn(
                  "w-full px-4 py-2 text-left text-sm flex items-center gap-3 transition-colors",
                  menuItem.disabled
                    ? "text-gray-600 cursor-not-allowed"
                    : menuItem.danger
                    ? "text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    : "text-gray-300 hover:bg-dark-800 hover:text-gray-100",
                )}
              >
                {menuItem.icon && (
                  <span class="w-4 h-4 flex-shrink-0">{menuItem.icon}</span>
                )}
                <span>{menuItem.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
