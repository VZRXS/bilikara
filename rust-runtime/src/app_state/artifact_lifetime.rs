//! Immutable cache resources share AppState's admission lock, not its snapshots.
//! Lock order: a caller enters AppState only. Retirement closes admission and
//! renames under that lock; recursive deletion happens after releasing it. No
//! observer, Python callback, or cache-worker lock is acquired from here.
use super::*;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ArtifactKey {
    incarnation: String,
    artifact: String,
}

impl ArtifactKey {
    fn new(incarnation: &str, artifact: &str) -> Option<Self> {
        (valid_authoritative_identity(incarnation, 'i')
            && valid_authoritative_identity(artifact, 'a'))
        .then(|| Self {
            incarnation: incarnation.into(),
            artifact: artifact.into(),
        })
    }

    fn relative(&self, area: &str) -> PathBuf {
        Path::new(area).join(&self.incarnation).join(&self.artifact)
    }

    fn media(path: &str) -> Option<Self> {
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() < 4
            || parts[0] != "artifacts"
            || parts
                .iter()
                .any(|p| p.is_empty() || p.starts_with('.') || p.contains(['\\', ':', '%', '\0']))
        {
            return None;
        }
        Self::new(parts[1], parts[2])
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Claim {
    client: String,
    generation: u64,
    key: ArtifactKey,
}

#[derive(Debug, Default)]
pub(crate) struct ArtifactLifetime {
    root: Option<PathBuf>,
    owner: String,
    closed: bool,
    // Outstanding physical attempts survive supersession/removal until their
    // exact worker terminal arrives. AppState's active attempt is still the
    // sole authority for accepting a publication into the playlist.
    attempts: HashMap<u64, CacheAttemptReservation>,
    known: HashSet<ArtifactKey>,
    retired: HashMap<ArtifactKey, bool>, // true while deletion runs outside lock
    programs: HashMap<u64, ArtifactKey>,
    claims: HashSet<Claim>,
    retired_generations: HashMap<String, u64>,
    readers: HashMap<String, ArtifactKey>,
}

fn opaque_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn unsafe_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

// The configured root may itself be an OS alias. Descendants may not redirect
// traversal. Callers use the canonical root captured at trusted configuration.
fn checked_path(root: &Path, relative: &Path, create: bool) -> io::Result<PathBuf> {
    let mut path = root.to_path_buf();
    for part in relative.components() {
        let std::path::Component::Normal(part) = part else {
            return Err(io::Error::other("unsafe cache descendant"));
        };
        path.push(part);
        if create && !path.exists() {
            fs::create_dir(&path)?;
        }
        match fs::symlink_metadata(&path) {
            Ok(meta) if unsafe_link(&meta) => return Err(io::Error::other("unsafe cache link")),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && !create => {}
            Err(error) => return Err(error),
        }
    }
    Ok(path)
}

impl AppState {
    pub(crate) fn open_artifact_lifetime(&mut self, root: &Path) -> io::Result<String> {
        if self.data.is_none() {
            return Err(io::Error::other("AppState is not initialized"));
        }
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        let lifetime = &mut self.artifact_lifetime;
        if lifetime.root.is_some()
            && (!lifetime.closed
                || !lifetime.readers.is_empty()
                || lifetime.retired.values().any(|deleting| *deleting))
        {
            return Err(io::Error::other("cache lifetime already has an owner"));
        }
        if lifetime.root.as_ref().is_some_and(|old| old != &root) {
            return Err(io::Error::other("cache lifetime root changed"));
        }
        lifetime.root = Some(root);
        lifetime.owner = opaque_token()?;
        lifetime.closed = false;
        Ok(lifetime.owner.clone())
    }

    pub(crate) fn artifact_owner(&self, owner: &str) -> bool {
        !owner.is_empty() && self.artifact_lifetime.owner == owner
    }

    pub(crate) fn artifact_drain_pending(&self) -> bool {
        !self.artifact_lifetime.readers.is_empty()
            || !self.artifact_lifetime.retired.is_empty()
            || (self.artifact_lifetime.closed && !self.artifact_lifetime.known.is_empty())
    }

    pub(crate) fn shutdown_artifact_lifetime(&mut self) {
        self.artifact_lifetime.closed = true;
        self.artifact_lifetime.claims.clear();
        // Existing bodies may finish after AppState's data shuts down. Their
        // opaque handles still release exactly their old resources; a new
        // Initialize cannot replace this owner until the readers/deleters drain.
    }

    pub(crate) fn close_artifact_lifetime(&mut self, owner: &str) -> bool {
        if !self.artifact_owner(owner) {
            return false;
        }
        self.artifact_lifetime.closed = true;
        self.artifact_lifetime.claims.clear();
        true
    }

    pub(crate) fn track_artifact_attempt(&mut self, reservation: &CacheAttemptReservation) {
        self.artifact_lifetime
            .attempts
            .insert(reservation.cache_attempt_token, reservation.clone());
    }

    pub(crate) fn register_artifact_attempt(&mut self, token: u64) -> io::Result<bool> {
        let lifetime = &mut self.artifact_lifetime;
        let Some(reservation) = lifetime.attempts.get(&token) else {
            return Ok(false);
        };
        let Some(root) = &lifetime.root else {
            return Ok(false);
        };
        let key = ArtifactKey::new(
            &reservation.item_incarnation_id,
            &reservation.artifact_set_id,
        )
        .ok_or_else(|| io::Error::other("invalid artifact reservation"))?;
        if lifetime.retired.contains_key(&key) {
            return Ok(false);
        }
        let path = checked_path(root, &key.relative("artifacts"), false)?;
        if !path.is_dir() {
            return Ok(false);
        }
        lifetime.known.insert(key);
        Ok(true)
    }

    pub(crate) fn publish_external_artifact(&mut self, token: u64) -> io::Result<bool> {
        let Some(reservation) = self.artifact_lifetime.attempts.get(&token).cloned() else {
            return Ok(false);
        };
        if self.artifact_lifetime.closed {
            return Ok(false);
        }
        let Some(data) = &self.data else {
            return Ok(false);
        };
        if validate_cache_attempt_ownership(
            data,
            &reservation.item_id,
            token,
            self.next_cache_attempt_token,
        )
        .is_err()
        {
            return Ok(false);
        }
        let root = self
            .artifact_lifetime
            .root
            .as_ref()
            .ok_or_else(|| io::Error::other("cache lifetime unavailable"))?;
        let key = ArtifactKey::new(
            &reservation.item_incarnation_id,
            &reservation.artifact_set_id,
        )
        .expect("issued identity");
        let source = checked_path(
            root,
            &Path::new(".staging")
                .join(format!("attempt-{token}"))
                .join("complete"),
            false,
        )?;
        let relative = key.relative("artifacts");
        checked_path(root, relative.parent().expect("identity parent"), true)?;
        let destination = checked_path(root, &relative, false)?;
        crate::file_publication::publish_directory_no_replace(&source, &destination)?;
        self.artifact_lifetime.known.insert(key);
        Ok(true)
    }

    pub(crate) fn artifact_ready_registered(&self, incarnation: &str, artifact: &str) -> bool {
        self.artifact_lifetime.root.is_none()
            || ArtifactKey::new(incarnation, artifact)
                .is_some_and(|key| self.artifact_lifetime.known.contains(&key))
    }

    pub(crate) fn settle_artifact_attempt(&mut self, item: &str, token: u64) {
        if self
            .artifact_lifetime
            .attempts
            .get(&token)
            .is_some_and(|r| r.item_id == item)
        {
            // Failure alone is not proof of publication: a no-replace collision
            // must never adopt and delete someone else's preexisting directory.
            self.artifact_lifetime.attempts.remove(&token);
        }
    }

    pub(crate) fn register_runtime_publication(
        &mut self,
        reservation: &CacheAttemptReservation,
        root: &Path,
    ) -> io::Result<bool> {
        if self
            .artifact_lifetime
            .attempts
            .get(&reservation.cache_attempt_token)
            != Some(reservation)
            || self.artifact_lifetime.root.as_ref() != Some(&root.canonicalize()?)
        {
            return Ok(false);
        }
        self.register_artifact_attempt(reservation.cache_attempt_token)
    }

    pub(crate) fn register_ready_artifact(
        &mut self,
        item: &str,
        token: u64,
        incarnation: &str,
        artifact: &str,
        directory: &str,
    ) {
        if self
            .artifact_lifetime
            .attempts
            .get(&token)
            .is_some_and(|r| {
                r.item_id == item
                    && r.item_incarnation_id == incarnation
                    && r.artifact_set_id == artifact
                    && r.artifact_relative_directory == directory
            })
        {
            let _ = self.register_artifact_attempt(token);
        }
    }

    pub(crate) fn settle_artifact_reservation(&mut self, reservation: &CacheAttemptReservation) {
        if self
            .artifact_lifetime
            .attempts
            .get(&reservation.cache_attempt_token)
            == Some(reservation)
        {
            self.settle_artifact_attempt(&reservation.item_id, reservation.cache_attempt_token);
        }
    }

    pub(crate) fn observe_artifact_program(&mut self) {
        if let Some(data) = &self.data
            && let Ok(Some(program)) = data.playback_program()
            && let Some(key) = program
                .artifact_set_id
                .as_deref()
                .and_then(|a| ArtifactKey::new(&program.item_incarnation_id, a))
        {
            self.artifact_lifetime
                .programs
                .insert(data.playback_generation, key);
        }
    }

    pub(crate) fn claim_artifact_program(
        &mut self,
        client: &str,
        generation: u64,
        incarnation: &str,
        artifact: &str,
        retire: bool,
    ) -> io::Result<bool> {
        let client = client.trim();
        if client.is_empty()
            || client.len() > 128
            || client.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(io::Error::other("invalid Host client identity"));
        }
        let key = ArtifactKey::new(incarnation, artifact)
            .filter(|_| generation > 0 && generation <= MAX_SAFE_JSON_INTEGER)
            .ok_or_else(|| io::Error::other("invalid Host playback artifact identity"))?;
        let lifetime = &mut self.artifact_lifetime;
        if lifetime.closed || lifetime.programs.get(&generation) != Some(&key) {
            return Ok(false);
        }
        let claim = Claim {
            client: client.into(),
            generation,
            key: key.clone(),
        };
        if retire {
            let watermark = lifetime
                .retired_generations
                .entry(client.into())
                .or_default();
            *watermark = (*watermark).max(generation);
            return Ok(lifetime.claims.remove(&claim));
        }
        if generation <= *lifetime.retired_generations.get(client).unwrap_or(&0)
            || !lifetime.known.contains(&key)
            || lifetime.retired.contains_key(&key)
        {
            return Ok(false);
        }
        lifetime.claims.insert(claim);
        Ok(true)
    }

    pub(crate) fn acquire_artifact_reader(&mut self, relative: &str) -> io::Result<Option<String>> {
        let Some(key) = ArtifactKey::media(relative) else {
            return Ok(None);
        };
        let lifetime = &mut self.artifact_lifetime;
        if lifetime.closed || !lifetime.known.contains(&key) || lifetime.retired.contains_key(&key)
        {
            return Ok(None);
        }
        let Some(root) = &lifetime.root else {
            return Ok(None);
        };
        if checked_path(root, Path::new(relative), false).is_err() {
            return Ok(None);
        }
        let handle = opaque_token()?;
        lifetime.readers.insert(handle.clone(), key);
        Ok(Some(handle))
    }

    pub(crate) fn release_artifact_reader(&mut self, handle: &str) -> bool {
        self.artifact_lifetime.readers.remove(handle).is_some()
    }

    #[cfg(feature = "native-host")]
    pub(crate) fn artifact_reader_count(&self) -> usize {
        self.artifact_lifetime.readers.len()
    }

    fn artifact_protected(&self, key: &ArtifactKey) -> bool {
        self.data
            .iter()
            .flat_map(|data| data.current_item.iter().chain(&data.playlist))
            .any(|item| {
                item.item_incarnation_id == key.incarnation && item.artifact_set_id == key.artifact
            })
            || self.artifact_lifetime.attempts.values().any(|r| {
                r.item_incarnation_id == key.incarnation && r.artifact_set_id == key.artifact
            })
            || self.artifact_lifetime.claims.iter().any(|c| &c.key == key)
            || self.artifact_lifetime.readers.values().any(|k| k == key)
            || self.native_artifact_claimed(&key.incarnation, &key.artifact)
    }

    #[cfg(all(feature = "native-host", test))]
    pub(crate) fn can_retire_artifact(&self, incarnation: &str, artifact: &str) -> bool {
        ArtifactKey::new(incarnation, artifact).is_some_and(|key| !self.artifact_protected(&key))
    }

    #[cfg(feature = "native-host")]
    pub(crate) fn artifact_program_retired(&self, client: &str, generation: u64) -> bool {
        generation
            <= *self
                .artifact_lifetime
                .retired_generations
                .get(client)
                .unwrap_or(&0)
    }

    #[cfg(feature = "native-host")]
    pub(crate) fn retire_native_program(
        &mut self,
        client: &str,
        generation: u64,
        incarnation: &str,
        artifact: &str,
    ) {
        if ArtifactKey::new(incarnation, artifact).as_ref()
            == self.artifact_lifetime.programs.get(&generation)
        {
            let watermark = self
                .artifact_lifetime
                .retired_generations
                .entry(client.into())
                .or_default();
            *watermark = (*watermark).max(generation);
        }
    }

    #[cfg(not(feature = "native-host"))]
    fn native_artifact_claimed(&self, _: &str, _: &str) -> bool {
        false
    }

    #[cfg(feature = "native-host")]
    fn recover_native_artifact(
        &mut self,
        root: &Path,
        area: &str,
        key: ArtifactKey,
    ) -> io::Result<()> {
        if self.artifact_lifetime.root.as_deref() != Some(root) {
            return Err(io::Error::other("native cache recovery owner changed"));
        }
        let path = checked_path(root, &key.relative(area), false)?;
        if !path.is_dir() || self.artifact_protected(&key) {
            return Ok(());
        }
        if area == "artifacts" {
            self.artifact_lifetime.known.insert(key);
        } else if area == ".retired" || self.retire_artifact_path(root, &key, area)?.is_some() {
            self.artifact_lifetime.retired.insert(key, false);
        }
        Ok(())
    }

    fn retire_artifact_path(
        &self,
        root: &Path,
        key: &ArtifactKey,
        area: &str,
    ) -> io::Result<Option<PathBuf>> {
        let source = checked_path(root, &key.relative(area), false)?;
        if !source.exists() {
            return Ok(None);
        }
        if !source.is_dir() {
            return Err(io::Error::other("artifact is not a directory"));
        }
        let relative = key.relative(".retired");
        checked_path(root, relative.parent().expect("identity parent"), true)?;
        let destination = checked_path(root, &relative, false)?;
        crate::file_publication::publish_directory_no_replace(&source, &destination)?;
        Ok(Some(destination))
    }

    pub(crate) fn prepare_artifact_collection(&mut self) -> Vec<RetiredArtifact> {
        let Some(root) = self.artifact_lifetime.root.clone() else {
            return Vec::new();
        };
        let keys: Vec<_> = self.artifact_lifetime.known.iter().cloned().collect();
        for key in keys {
            if self.artifact_protected(&key) {
                continue;
            }
            // A failed rename leaves registration and admission intact for retry.
            match self.retire_artifact_path(&root, &key, "artifacts") {
                Ok(path) => {
                    self.artifact_lifetime.known.remove(&key);
                    self.artifact_lifetime.programs.retain(|_, k| k != &key);
                    if path.is_some() {
                        self.artifact_lifetime.retired.insert(key, false);
                    }
                }
                Err(_) => continue,
            }
        }
        self.artifact_lifetime
            .retired
            .iter_mut()
            .filter_map(|(key, deleting)| {
                if *deleting {
                    return None;
                }
                *deleting = true;
                Some(RetiredArtifact {
                    root: root.clone(),
                    key: key.clone(),
                    owner: self.artifact_lifetime.owner.clone(),
                })
            })
            .collect()
    }

    pub(crate) fn finish_artifact_collection(&mut self, retired: &RetiredArtifact, deleted: bool) {
        if self.artifact_lifetime.owner != retired.owner {
            return;
        }
        if deleted {
            self.artifact_lifetime.retired.remove(&retired.key);
        } else if let Some(deleting) = self.artifact_lifetime.retired.get_mut(&retired.key) {
            *deleting = false;
        }
    }
}

pub(crate) struct RetiredArtifact {
    root: PathBuf,
    key: ArtifactKey,
    owner: String,
}

impl RetiredArtifact {
    pub(crate) fn delete(&self) -> io::Result<()> {
        let path = checked_path(&self.root, &self.key.relative(".retired"), false)?;
        // Reject links/reparse points throughout the owned tree. This is slow
        // work outside AppState; admission to the original path is already shut.
        fn check_tree(path: &Path) -> io::Result<()> {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let meta = fs::symlink_metadata(entry.path())?;
                if unsafe_link(&meta) {
                    return Err(io::Error::other("unsafe retired artifact link"));
                }
                if meta.is_dir() {
                    check_tree(&entry.path())?;
                }
            }
            Ok(())
        }
        if !path.exists() {
            return Ok(());
        }
        check_tree(&path)?;
        fs::remove_dir_all(&path)?;
        let _ = fs::remove_dir(path.parent().expect("identity parent"));
        Ok(())
    }
}

/// Only native startup discovers old generated identities in its exclusively
/// locked private storage. Directory enumeration runs outside AppState; each
/// candidate is rechecked with admission closed under the normal lifetime lock.
/// The default Host never scans unknown artifacts or staging directories.
#[cfg(feature = "native-host")]
pub(crate) fn recover_native_artifacts(root: &Path, area: &str) -> io::Result<()> {
    let root = root.canonicalize()?;
    let parent = checked_path(&root, Path::new(area), false)?;
    if !parent.is_dir() {
        return Ok(());
    }
    for incarnation in fs::read_dir(parent)? {
        let incarnation = incarnation?;
        if !incarnation.file_type()?.is_dir() {
            continue;
        }
        let i = incarnation.file_name().to_string_lossy().into_owned();
        if !valid_authoritative_identity(&i, 'i') {
            continue;
        }
        checked_path(&root, &Path::new(area).join(&i), false)?;
        for artifact in fs::read_dir(incarnation.path())? {
            let artifact = artifact?;
            if !artifact.file_type()?.is_dir() {
                continue;
            }
            let Some(key) = ArtifactKey::new(&i, &artifact.file_name().to_string_lossy()) else {
                continue;
            };
            with_cache_application(|app| app.recover_native_artifact(&root, area, key))
                .map_err(|e| io::Error::other(e.message))??;
        }
    }
    Ok(())
}

pub(crate) fn collect_artifacts(owner: Option<&str>) -> io::Result<usize> {
    let jobs = with_cache_application(|app| {
        if owner.is_some_and(|owner| !app.artifact_owner(owner)) {
            Vec::new()
        } else {
            app.prepare_artifact_collection()
        }
    })
    .map_err(|e| io::Error::other(e.message))?;
    let mut deleted = 0;
    for job in jobs {
        let ok = job.delete().is_ok();
        with_cache_application(|app| app.finish_artifact_collection(&job, ok))
            .map_err(|e| io::Error::other(e.message))?;
        deleted += usize::from(ok);
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests;
