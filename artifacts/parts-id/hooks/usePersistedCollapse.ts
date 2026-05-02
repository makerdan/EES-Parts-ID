/**
 * `useState`-shaped hook that persists a collapsed/expanded boolean to
 * AsyncStorage so settings sections remember their open state across app
 * relaunches. Async-loaded — the initial render uses `defaultCollapsed`
 * and re-renders once storage resolves.
 */
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
 *   - isLoaded        true once the AsyncStorage read has resolved (even if no stored value existed).
 *                    Resets to false and re-reads if `key` changes.
 */
export function usePersistedCollapse(
  key: string,
  defaultValue: boolean = true,
): [boolean, () => void, (v: boolean) => void, boolean] {
  const [collapsed, setCollapsedState] = useState<boolean>(defaultValue);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
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
  }, [key]);

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
