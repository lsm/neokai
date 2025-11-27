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
  customContent?: ComponentChildren; // Optional custom content instead of menu items
}

export function Dropdown({
  trigger,
  items,
  position = "right",
  class: className,
  customContent,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Calculate and update menu position when opened
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Start with position below the trigger
      let top = triggerRect.bottom + 8; // 8px spacing (mt-2)

      // Check if there's enough space below, otherwise position above
      const estimatedMenuHeight = 400; // Approximate max height
      if (top + estimatedMenuHeight > viewportHeight && triggerRect.top > estimatedMenuHeight) {
        top = triggerRect.top - estimatedMenuHeight - 8;
      }

      // Calculate horizontal position
      const newPosition: { top: number; left?: number; right?: number } = { top };

      if (position === "right") {
        // Align to right edge of trigger
        const right = viewportWidth - triggerRect.right;
        newPosition.right = right;
      } else {
        // Align to left edge of trigger
        newPosition.left = triggerRect.left;
      }

      setMenuPosition(newPosition);
    }
  }, [isOpen, position]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Don't close if clicking inside the menu (which uses position:fixed)
      // Check both dropdownRef and menuRef since fixed positioning can affect contains()
      if (
        menuRef.current?.contains(event.target as Node) ||
        (dropdownRef.current && dropdownRef.current.contains(event.target as Node))
      ) {
        return;
      }

      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      // Use 'click' instead of 'mousedown' to allow onClick handlers to fire first
      document.addEventListener("click", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("click", handleClickOutside);
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
      <div ref={triggerRef} onClick={() => setIsOpen(!isOpen)}>{trigger}</div>

      {/* Menu - Using fixed positioning to avoid clipping by overflow containers */}
      {isOpen && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: `${menuPosition.top}px`,
            ...(menuPosition.left !== undefined ? { left: `${menuPosition.left}px` } : {}),
            ...(menuPosition.right !== undefined ? { right: `${menuPosition.right}px` } : {}),
          }}
          class={cn(
            "shadow-xl z-[100] animate-slideIn",
            customContent
              ? ""
              : "py-1 bg-dark-850 border border-dark-700 rounded-lg min-w-[200px]",
          )}
          role="menu"
        >
          {customContent ? (
            customContent
          ) : (
            <>
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
                    onClick={async (e) => {
                      if (!menuItem.disabled) {
                        // Stop propagation to prevent handleClickOutside from closing dropdown prematurely
                        e.stopPropagation();
                        menuItem.onClick(e);
                        // Small delay to ensure state updates propagate before closing dropdown
                        // This helps with modal/dialog triggers that depend on dropdown item clicks
                        await new Promise(resolve => setTimeout(resolve, 0));
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
