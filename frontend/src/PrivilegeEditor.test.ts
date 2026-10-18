import { expect, test } from "vitest";
import { availableActions, resourceNames } from "./PrivilegeEditor";

test("privilege action choices respect cluster and database resource scopes", () => {
  const roles = [
    {
      privileges: [
        { resource: { db: "", collection: "" }, actions: ["find", "insert"] },
        { resource: { cluster: true }, actions: ["serverStatus", "killop"] },
        { resource: { anyResource: true }, actions: ["anyAction", "find"] },
      ],
      inheritedPrivileges: [
        { resource: { cluster: true }, actions: ["killop"] },
      ],
    },
  ];
  expect(availableActions(roles, "database")).toEqual(["find", "insert"]);
  expect(availableActions(roles, "cluster")).toEqual([
    "killop",
    "serverStatus",
  ]);
  expect(availableActions(roles, "any")).toContain("anyAction");
});

test("picker metadata preserves existing resources when catalogs are incomplete", () => {
  expect(resourceNames(["events", "events"], "archived_events", "")).toEqual([
    { value: "archived_events", label: "archived_events" },
    { value: "events", label: "events" },
  ]);
});
