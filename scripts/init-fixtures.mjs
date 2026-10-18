import { execFileSync } from "node:child_process";
for (const version of [8, 9]) {
  execFileSync(
    "docker",
    [
      "exec",
      `datahelm-test-mongo${version}`,
      "mongosh",
      "-u",
      "admin",
      "-p",
      "datahelm-test-only",
      "--authenticationDatabase",
      "admin",
      "--quiet",
      "--eval",
      "db.getSiblingDB('browser_fixture').events.updateOne({_id:1},{$set:{kind:'browser test'}},{upsert:true})",
    ],
    { stdio: "ignore" },
  );
}
function shell(service, code) {
  return execFileSync(
    "docker",
    [
      "compose",
      "-p",
      "datahelm-fixtures",
      "-f",
      "compose.tests.yaml",
      "exec",
      "-T",
      service,
      "mongosh",
      "--quiet",
      "--eval",
      code,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
}
for (const [service, config] of [
  [
    "rs1",
    {
      _id: "datahelm-rs",
      members: [
        { _id: 0, host: "rs1:27017" },
        { _id: 1, host: "rs2:27017" },
        { _id: 2, host: "rs3:27017" },
      ],
    },
  ],
  [
    "config",
    {
      _id: "datahelm-config",
      configsvr: true,
      members: [{ _id: 0, host: "config:27017" }],
    },
  ],
  [
    "shard1",
    { _id: "datahelm-shard1", members: [{ _id: 0, host: "shard1:27017" }] },
  ],
  [
    "shard2",
    { _id: "datahelm-shard2", members: [{ _id: 0, host: "shard2:27017" }] },
  ],
]) {
  shell(
    service,
    `try { rs.status() } catch(e) { rs.initiate(${JSON.stringify(config)}) }`,
  );
  console.log(`${service} replica configuration initialized`);
}
for (let i = 0; i < 40; i++) {
  try {
    shell(
      "router",
      `
        sh.addShard('datahelm-shard1/shard1:27017');
        sh.addShard('datahelm-shard2/shard2:27017');
        sh.stopBalancer();
        db.adminCommand({enableSharding:'fixture',primaryShard:'datahelm-shard1'});
        const d=db.getSiblingDB('fixture');
        if (!db.getSiblingDB('config').collections.findOne({_id:'fixture.events'})) {
          db.adminCommand({shardCollection:'fixture.events',key:{_id:1}});
          db.adminCommand({split:'fixture.events',middle:{_id:0}});
        }
        d.events.updateOne({_id:-1},{$set:{value:'first shard'}},{upsert:true});
        d.events.updateOne({_id:1},{$set:{value:'second shard'}},{upsert:true});
        const metadata=db.getSiblingDB('config').collections.findOne({_id:'fixture.events'});
        const upperChunk=db.getSiblingDB('config').chunks.findOne({uuid:metadata.uuid,'min._id':0});
        if (!upperChunk) throw new Error('Expected fixture split at zero');
        if (upperChunk.shard !== 'datahelm-shard2') {
          db.adminCommand({moveChunk:'fixture.events',find:{_id:1},to:'datahelm-shard2',_waitForDelete:true});
        }
      `,
    );
    console.log("Sharded cluster initialized");
    break;
  } catch (e) {
    if (i === 39) throw e;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
for (const shard of ["shard1", "shard2"]) {
  const count = Number(
    shell(shard, "db.getSiblingDB('fixture').events.countDocuments({})").trim(),
  );
  if (count !== 1)
    throw new Error(`Expected one physical fixture document on ${shard}`);
}
console.log("Fixture data is distributed across both shards.");
