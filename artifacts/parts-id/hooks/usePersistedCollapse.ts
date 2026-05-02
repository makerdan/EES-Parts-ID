import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persists a boolean collapsed/expanded state in AsyncStorage.
 *
 * @param key           AsyncStorage key (use a namespaced string, e.g. "@partsid/my_section")
 * @param defaultValue  Initial value used on first launch (before AsyncStorage responds)
 * @returns [collapsed, toggleCollapsed, setCollapsed, isLoaded]
 *   - collapsed       current collapsed state
 *   - toggleCollapsed flip + persist the state
 *   - setCollapsed    set to a specific value + persist
 *   - isLoaded        true once the AsyncStorage read has resolved (even if no stored value existed)
 */
export function usePersistedCollapse(
  key: string,
  defaultValue: boolean = true,
): [boolean, () => void, (v: boolean) => void, boolean] {
  const [collapsed, setCollapsedState] = useState<boolean>(defaultValue);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(key)
      .then(stored => {
        if (stored !== null) {
          setCollapsedState(stored === "1");
        }
        setIsLoaded(true);
      })
      .catch(() => {
        setIsLoaded(true);
      });
  // key is stable; only run on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCollapsed = useCallback(
    (v: boolean) => {
      setCollapsedState(v);
      AsyncStorage.setItem(key, v ? "1" : "0").catch(() => {});
    },
    [key],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsedState(prev => {
      const next = !prev;
      AsyncStorage.setItem(key, next ? "1" : "0").catch(() => {});
      return next;
    });
  }, [key]);

  return [collapsed, toggleCollapsed, setCollapsed, isLoaded];
}
