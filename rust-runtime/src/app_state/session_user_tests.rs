use super::*;

fn command(app: &mut AppState, value: Value) -> AppSnapshot {
    let response = app.execute(serde_json::from_value(value).unwrap());
    assert!(response.error().is_none(), "{:?}", response.error());
    response.snapshot().unwrap().clone()
}

fn fixture() -> AppState {
    let mut app = AppState::default();
    command(
        &mut app,
        json!({"schema_version":1,"command":"initialize","state":{
            "session_users":["Alice","Bob","Carol","Dana"],
            "session_started_at":1.0,"session_played_file":"users.json","updated_at":1.0
        }}),
    );
    app
}

fn video(id: &str) -> Value {
    json!({"id":id,"original_url":"https://www.bilibili.com/video/BV1ab411c7mD",
        "resolved_url":"https://www.bilibili.com/video/BV1ab411c7mD","bvid":"BV1ab411c7mD",
        "aid":1,"cid":2,"title":id,"part_title":"Original","display_title":id,"cover_url":"","embed_url":""})
}

fn add(app: &mut AppState, id: &str, name: &str, user_id: Option<&str>) -> AppSnapshot {
    command(
        app,
        json!({"schema_version":1,"command":"add_item","item":video(id),
        "position":"tail","requester_name":name,"requester_user_id":user_id,"allow_repeat":true,"now":2.0}),
    )
}

fn edit(app: &mut AppState, value: Value) -> AppSnapshot {
    let version = app.data.as_ref().unwrap().users_version();
    command(
        app,
        json!({"schema_version":1,"command":"edit_session_users","expected_version":version,"edit":value,"now":3.0}),
    )
}

fn id(app: &AppState, name: &str) -> String {
    app.data.as_ref().unwrap().session_user_ids[name].clone()
}

#[test]
fn rename_keeps_request_labels_order_program_and_singer_identity() {
    let mut app = fixture();
    let alice = id(&app, "Alice");
    add(&mut app, "archived", "Alice", None);
    command(
        &mut app,
        json!({"schema_version":1,"command":"mark_current_item_started","item_id":"archived","now":2.0}),
    );
    let generation = app.data.as_ref().unwrap().playback_generation;
    command(
        &mut app,
        json!({"schema_version":1,"command":"advance_to_next","expected_playback_generation":generation,"now":2.0}),
    );
    add(&mut app, "playing", "Alice", None);
    add(&mut app, "alice-one", "Alice", None);
    let before = add(&mut app, "bob-one", "Bob", None);
    let after = edit(
        &mut app,
        json!({"action":"rename","user_id":alice,"name":" Aimer "}),
    );
    assert_eq!(after.current_item, before.current_item);
    assert_eq!(after.playlist, before.playlist);
    assert_eq!(after.history, before.history);
    assert_eq!(after.history[0].requester_name, "Alice");
    assert_eq!(after.session_history, before.session_history);
    assert_eq!(after.session_played, before.session_played);
    assert_eq!(after.playback_program, before.playback_program);
    assert_eq!(after.playback_generation, before.playback_generation);
    assert_eq!(after.queue_version, before.queue_version);
    assert_eq!(after.session_user_entries[0].id, alice);
    assert_eq!(after.session_users[0], "Aimer");
    let after = add(&mut app, "aimer-new", "Aimer", None);
    assert_eq!(
        after
            .playlist
            .iter()
            .find(|item| item.id == "aimer-new")
            .unwrap()
            .requester_name,
        "Aimer"
    );
    // All Alice/Aimer songs still share one round-robin participant.
    let data = app.data.as_ref().unwrap();
    assert_eq!(data.requester_user_ids["playing"], alice);
    assert_eq!(data.requester_user_ids["alice-one"], alice);
    assert_eq!(data.requester_user_ids["aimer-new"], alice);
    assert_eq!(
        after
            .playlist
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["bob-one", "alice-one", "aimer-new"]
    );
}

#[test]
fn admitted_request_finishing_after_rename_keeps_its_original_label() {
    let mut app = fixture();
    let alice = id(&app, "Alice");
    edit(
        &mut app,
        json!({"action":"rename","user_id":alice,"name":"Aimer"}),
    );
    let snapshot = add(&mut app, "delayed", "Alice", Some(&alice));
    assert_eq!(snapshot.current_item.unwrap().requester_name, "Alice");
    assert_eq!(snapshot.session_played[0].requester_name, "Alice");
    command(
        &mut app,
        json!({"schema_version":1,"command":"mark_current_item_started","item_id":"delayed","now":4.0}),
    );
    let generation = app.data.as_ref().unwrap().playback_generation;
    let snapshot = command(
        &mut app,
        json!({"schema_version":1,"command":"advance_to_next","expected_playback_generation":generation,"now":5.0}),
    );
    assert_eq!(snapshot.history[0].requester_name, "Alice");
    assert_eq!(snapshot.session_history[0].requester_name, "Alice");
}

#[test]
fn same_name_reuse_never_claims_an_old_request_or_pending_admission() {
    let mut app = fixture();
    let old_id = id(&app, "Alice");
    add(&mut app, "old", "Alice", None);
    edit(&mut app, json!({"action":"remove","user_ids":[old_id]}));
    command(
        &mut app,
        json!({"schema_version":1,"command":"add_session_user","name":"Alice","now":4.0}),
    );
    assert_ne!(id(&app, "Alice"), old_id);
    assert_eq!(app.data.as_ref().unwrap().requester_user_ids["old"], old_id);
    let response = app.execute(serde_json::from_value(json!({"schema_version":1,"command":"add_item","item":video("late"),"position":"tail","requester_name":"Alice","requester_user_id":old_id,"allow_repeat":true,"now":5.0})).unwrap());
    assert_eq!(response.error().unwrap().kind, "session_user_not_found");
    assert_eq!(
        app.data
            .as_ref()
            .unwrap()
            .current_item
            .as_ref()
            .unwrap()
            .requester_name,
        "Alice"
    );
}

#[test]
fn batch_reorder_preserves_internal_order_and_leaves_other_users_present() {
    let mut app = fixture();
    let bob = id(&app, "Bob");
    let dana = id(&app, "Dana");
    let alice = id(&app, "Alice");
    let snapshot = edit(
        &mut app,
        json!({"action":"reorder","user_ids":[dana,bob],"before_user_id":alice}),
    );
    assert_eq!(snapshot.session_users, ["Bob", "Dana", "Alice", "Carol"]);
    let snapshot = edit(&mut app, json!({"action":"remove","user_ids":[dana,bob]}));
    assert_eq!(snapshot.session_users, ["Alice", "Carol"]);
}

#[test]
fn stale_batch_and_invalid_selection_are_atomic() {
    let mut app = fixture();
    let version = app.data.as_ref().unwrap().users_version();
    let alice = id(&app, "Alice");
    let before = command(
        &mut app,
        json!({"schema_version":1,"command":"add_session_user","name":"New phone","now":2.0}),
    );
    let response = app.execute(serde_json::from_value(json!({"schema_version":1,"command":"edit_session_users","expected_version":version,"edit":{"action":"remove","user_ids":[alice]},"now":3.0})).unwrap());
    assert_eq!(response.error().unwrap().kind, "session_users_changed");
    assert_eq!(app.data.as_ref().unwrap().snapshot().unwrap(), before);
    for ids in [json!([]), json!([alice, alice]), json!([alice, "missing"])] {
        let response = app.execute(serde_json::from_value(json!({"schema_version":1,"command":"edit_session_users","expected_version":before.session_users_version,"edit":{"action":"remove","user_ids":ids},"now":3.0})).unwrap());
        assert_eq!(response.error().unwrap().kind, "session_user_not_found");
        assert_eq!(app.data.as_ref().unwrap().snapshot().unwrap(), before);
    }
}

#[test]
fn duplicate_and_noop_renames_preserve_state_and_unicode_names() {
    let mut app = fixture();
    let alice = id(&app, "Alice");
    let before = app.data.as_ref().unwrap().snapshot().unwrap();
    let response = app.execute(serde_json::from_value(json!({"schema_version":1,"command":"edit_session_users","expected_version":before.session_users_version,"edit":{"action":"rename","user_id":alice,"name":"Bob"},"now":3.0})).unwrap());
    assert_eq!(response.error().unwrap().kind, "duplicate_session_user");
    assert_eq!(app.data.as_ref().unwrap().snapshot().unwrap(), before);
    assert_eq!(
        edit(
            &mut app,
            json!({"action":"rename","user_id":alice,"name":"  Alice  "})
        ),
        before
    );
    let name = "🎤".repeat(24);
    assert_eq!(
        edit(
            &mut app,
            json!({"action":"rename","user_id":alice,"name":name})
        )
        .session_users[0],
        name
    );
}

#[test]
fn checkpoint_preserves_ids_labels_and_changes_the_edit_epoch_on_restart() {
    let mut app = fixture();
    let alice = id(&app, "Alice");
    add(&mut app, "saved", "Alice", None);
    let before = edit(
        &mut app,
        json!({"action":"rename","user_id":alice,"name":"Aimer"}),
    );
    let data = app.data.as_ref().unwrap();
    let mut seed: AppStateSeed = serde_json::from_value(
        json!({"session_started_at":1.0,"session_played_file":"users.json","updated_at":3.0}),
    )
    .unwrap();
    seed.current_item = data.current_item.clone();
    seed.playlist = data.playlist.clone();
    seed.session_users = data.session_users.clone();
    seed.session_user_ids = data.session_user_ids.clone();
    seed.requester_user_ids = data.requester_user_ids.clone();
    let mut restored = AppState::default();
    let response = restored.execute(AppStateRequest::Initialize {
        schema_version: 1,
        state: Box::new(seed),
    });
    let snapshot = response.snapshot().unwrap();
    assert_eq!(snapshot.session_user_entries, before.session_user_entries);
    assert_eq!(
        snapshot.current_item.as_ref().unwrap().requester_name,
        "Alice"
    );
    assert_ne!(snapshot.session_users_version, before.session_users_version);
    assert_eq!(
        restored.data.as_ref().unwrap().requester_user_ids["saved"],
        alice
    );
}

fn open_peer(app: &mut AppState, peer: &str) {
    command(
        app,
        json!({"schema_version":1,"command":"open_internet_remote_peer","peer_id":peer,"epoch":"abcdefghijklmnopqrstuv","profile":"controller"}),
    );
}

fn public_request(
    app: &mut AppState,
    peer: &str,
    sequence: u64,
    kind: &str,
    body: Value,
) -> AppStateResponse {
    let message = json!({"v":1,"lane":"control","epoch":"abcdefghijklmnopqrstuv","seq":sequence,
        "id":format!("123e4567-e89b-42d3-a456-{sequence:012}"),"kind":kind,"body":body})
    .to_string();
    app.execute(
        serde_json::from_value(
            json!({"schema_version":1,"command":"dispatch_internet_remote_message",
        "peer_id":peer,"lane":"control","message":message,"now":10.0}),
        )
        .unwrap(),
    )
}

fn public_ok(response: AppStateResponse) -> Value {
    match response {
        AppStateResponse::Success(success) => success.result,
        other => panic!("public request failed: {other:?}"),
    }
}

#[test]
fn public_rename_syncs_peers_and_resume_cannot_recreate_a_deleted_singer() {
    let mut app = fixture();
    let alice = id(&app, "Alice");
    for peer in ["first", "second"] {
        open_peer(&mut app, peer);
        public_ok(public_request(
            &mut app,
            peer,
            1,
            "session.set_identity",
            json!({"name":"Alice"}),
        ));
    }
    public_ok(public_request(
        &mut app,
        "first",
        2,
        "session.rename",
        json!({"name":"Aimer","user_id":alice,"expected_name":"Alice"}),
    ));
    // The second device can rename immediately using the synchronized binding.
    public_ok(public_request(
        &mut app,
        "second",
        2,
        "session.rename",
        json!({"name":"Chorus","user_id":alice,"expected_name":"Aimer"}),
    ));
    let stale = public_request(
        &mut app,
        "first",
        3,
        "session.rename",
        json!({"name":"Stale","user_id":alice,"expected_name":"Alice"}),
    );
    assert_eq!(stale.error().unwrap().kind, "session_users_changed");
    open_peer(&mut app, "reconnected");
    let resumed = public_ok(public_request(
        &mut app,
        "reconnected",
        1,
        "session.resume",
        json!({"user_id":alice}),
    ));
    assert_eq!(resumed["data"]["name"], "Chorus");
    edit(&mut app, json!({"action":"remove","user_ids":[alice]}));
    command(
        &mut app,
        json!({"schema_version":1,"command":"add_session_user","name":"Alice","now":11.0}),
    );
    let rejected = public_request(
        &mut app,
        "reconnected",
        2,
        "session.resume",
        json!({"user_id":alice}),
    );
    assert_eq!(rejected.error().unwrap().kind, "identity_required");
    assert!(
        !app.data
            .as_ref()
            .unwrap()
            .session_users
            .contains(&"Chorus".to_owned())
    );
}

#[test]
fn public_pending_add_keeps_admission_label_and_rejects_a_retired_identity() {
    let mut app = fixture();
    let alice = id(&app, "Alice");
    open_peer(&mut app, "phone");
    public_ok(public_request(
        &mut app,
        "phone",
        1,
        "session.set_identity",
        json!({"name":"Alice"}),
    ));
    let revision = app.data.as_ref().unwrap().revision;
    let pending = public_ok(public_request(
        &mut app,
        "phone",
        2,
        "playlist.add",
        json!({"catalog_item_id":"BV1ab411c7mD","position":"tail","allow_repeat":true,"expected_revision":revision}),
    ));
    edit(
        &mut app,
        json!({"action":"rename","user_id":alice,"name":"Aimer"}),
    );
    let completed = command(
        &mut app,
        json!({"schema_version":1,"command":"complete_internet_remote_playlist_add","peer_id":"phone","request_id":pending["request_id"],"item":video("late-public"),"now":12.0}),
    );
    assert_eq!(completed.current_item.unwrap().requester_name, "Alice");
    let revision = app.data.as_ref().unwrap().revision;
    let pending = public_ok(public_request(
        &mut app,
        "phone",
        3,
        "playlist.add",
        json!({"catalog_item_id":"BV1ab411c7mD","position":"tail","allow_repeat":true,"expected_revision":revision}),
    ));
    edit(&mut app, json!({"action":"remove","user_ids":[alice]}));
    command(
        &mut app,
        json!({"schema_version":1,"command":"add_session_user","name":"Aimer","now":13.0}),
    );
    let response = app.execute(serde_json::from_value(json!({"schema_version":1,"command":"complete_internet_remote_playlist_add","peer_id":"phone","request_id":pending["request_id"],"item":video("retired-public"),"now":14.0})).unwrap());
    assert!(response.error().is_some());
    assert!(app.data.as_ref().unwrap().playlist.is_empty());
}
