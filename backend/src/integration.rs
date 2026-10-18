//! Opt-in tests only address explicitly provided disposable fixtures.
use crate::{AppState, api, auth, crypto::Vault, provider::MongoProvider, store::Store};
use axum::{Router, body::Body, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use mongodb::{
    Client,
    bson::{Document, doc},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn http_request(
    app: &Router,
    cookie: &str,
    csrf: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (u16, Value) {
    let request = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"))
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .header("content-type", "application/json")
        .body(if method == "GET" {
            Body::empty()
        } else {
            Body::from(serde_json::to_vec(&body).unwrap())
        })
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
#[ignore = "Set DATAHELM_TEST_URIS to disposable MongoDB 8/9 fixture URIs"]
async fn mongo_administration_end_to_end() {
    let uris =
        std::env::var("DATAHELM_TEST_URIS").expect("Explicit disposable fixture URIs are required");
    for uri in uris.split(';') {
        let client = Client::with_uri_str(uri).await.unwrap();
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let db = format!("datahelm_test_{suffix}");
        client
            .database(&db)
            .collection::<Document>("events")
            .insert_many([doc! {"value":1}, doc! {"value":2}, doc! {"value":3}])
            .await
            .unwrap();
        let store = Store::new(
            "sqlite::memory:",
            Vault::new(&STANDARD.encode([9; 32])).unwrap(),
        )
        .await
        .unwrap();
        auth::bootstrap(&store, "admin", || Ok("fixture-password-123".into()))
            .await
            .unwrap();
        let state = AppState {
            store,
            provider: Arc::new(MongoProvider::new(
                std::env::var("DATAHELM_RUNTIME_DIR")
                    .unwrap_or_else(|_| "/dev/shm/datahelm".into()),
            )),
            login_attempts: Default::default(),
            secure_cookie: false,
            origin: "http://localhost:8080".into(),
        };
        let (session, cookie) = auth::change_password(
            &state,
            "admin",
            crate::model::PasswordChange {
                current_password: "fixture-password-123".into(),
                new_password: "fixture-updated-password-123".into(),
            },
        )
        .await
        .unwrap();
        let app = api::router(state.clone());
        let request = |method: &'static str, path: String, body: Value| {
            let app = app.clone();
            let cookie = cookie.clone();
            let csrf = session.csrf_token.clone();
            async move {
                let (status, value) = http_request(&app, &cookie, &csrf, method, &path, body).await;
                assert_eq!(status, 200, "{path}: {value}");
                value
            }
        };
        let config = json!({"name":"Integration fixture","mode":"uri","uri":uri,"direct":true,"monitoring":false});
        let test = request("POST", "/connections/test".into(), json!({"config":config})).await;
        assert_eq!(test["ok"], true);
        let saved = request("POST", "/connections".into(), config).await;
        let id = saved["id"].as_str().unwrap();
        let path = |suffix: &str| format!("/connections/{id}/{suffix}");
        let caps = request("GET", path("capabilities"), json!(null)).await;
        assert_eq!(caps["features"]["users"]["available"], true);
        let catalogs = request("GET", path("databases"), json!(null)).await;
        assert!(catalogs.as_array().unwrap().iter().any(|r| r["name"] == db));
        let collections = request("GET", path(&format!("collections?db={db}")), json!(null)).await;
        let event = collections
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "events")
            .unwrap();
        assert_eq!(event["count"], 3.);
        assert_eq!(event["indexes"], 1.);
        let role = format!("role_{suffix}");
        let user = format!("user_{suffix}");
        request("POST",path("roles"),json!({"db":db,"role":role,"roles":[],"privileges":[{"resource":{"db":db,"collection":"events"},"actions":["find"]}]})).await;
        request("POST",path("users"),json!({"db":db,"user":user,"password":"temporary-test-only-password","roles":[{"db":db,"role":role}],"mechanisms":["SCRAM-SHA-256"]})).await;
        let access = request(
            "GET",
            path(&format!("users?db={db}&name={user}")),
            json!(null),
        )
        .await;
        assert!(
            access["users"][0]["inheritedPrivileges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["resource"]["collection"] == "events")
        );
        assert!(access["users"][0].get("credentials").is_none());
        request("PATCH",path("users"),json!({"db":db,"user":user,"roles":[{"db":db,"role":"read"}],"password":"changed-test-only-password"})).await;
        request(
            "PATCH",
            path("roles"),
            json!({"db":db,"role":role,"roles":[{"db":db,"role":"read"}],"privileges":[]}),
        )
        .await;
        let profiles = request(
            "PUT",
            path("profiler"),
            json!({"db":db,"enabled":true,"slow_ms":0}),
        )
        .await;
        assert_eq!(profiles["was"], 1);
        client
            .database(&db)
            .collection::<Document>("events")
            .find(doc! {})
            .await
            .unwrap();
        let entries = request("GET", path(&format!("profiles?db={db}")), json!(null)).await;
        assert!(entries["items"].as_array().is_some());
        request("PUT", path("profiler"), json!({"db":db,"enabled":false})).await;
        let topo = request("GET", path("topology"), json!(null)).await;
        assert!(topo["hello"].is_object());
        request("GET", path("operations"), json!(null)).await;
        let sample = state
            .provider
            .sample(
                &state.store,
                id,
                None,
                chrono::Utc::now().timestamp_millis(),
            )
            .await
            .unwrap();
        assert!(sample.connections.is_some());
        state.store.metric(id, &sample).await.unwrap();
        let metrics = request("GET", path("metrics"), json!(null)).await;
        assert!(!metrics.as_array().unwrap().is_empty());
        // MongoDB enforces resource-scoped privileges for a saved restricted account.
        let address = uri.split('@').nth(1).unwrap();
        let restricted = json!({"name":"Restricted fixture","mode":"uri","uri":format!("mongodb://{user}:changed-test-only-password@{address}").replace("authSource=admin",&format!("authSource={db}")),"monitoring":false});
        let restricted = request("POST", "/connections".into(), restricted).await;
        let rid = restricted["id"].as_str().unwrap();
        let (_, denied) = http_request(
            &app,
            &cookie,
            &session.csrf_token,
            "GET",
            &format!("/connections/{rid}/users"),
            json!(null),
        )
        .await;
        assert!(denied["message"].as_str().unwrap().contains("permission"));
        request("DELETE", path("users"), json!({"db":db,"name":user})).await;
        request("DELETE", path("roles"), json!({"db":db,"name":role})).await;
        request("DELETE", format!("/connections/{id}"), json!(null)).await;
        client.database(&db).drop().await.unwrap();
    }
}
