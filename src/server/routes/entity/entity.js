/*
 * Copyright (C) 2016  Ben Ockmore
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

'use strict';

const bookshelf = require('bookbrainz-data').bookshelf;
const _ = require('lodash');
const Editor = require('bookbrainz-data').Editor;
const Revision = require('bookbrainz-data').Revision;
const Note = require('bookbrainz-data').Note;
const Disambiguation = require('bookbrainz-data').Disambiguation;
const Annotation = require('bookbrainz-data').Annotation;
const status = require('http-status');
const Promise = require('bluebird');

const AliasSet = require('bookbrainz-data').AliasSet;
const IdentifierSet = require('bookbrainz-data').IdentifierSet;


module.exports.displayEntity = (req, res) => {
	const entity = res.locals.entity;
	let title = entity.type;

	if (entity.defaultAlias && entity.defaultAlias.name) {
		title += ` “${entity.defaultAlias.name}”`;
	}

	// Get unique identifier types for display
	const identifierTypes = entity.identifierSet &&
		_.uniq(
			_.map(entity.identifierSet.identifiers, 'type'),
			(type) => type.id
		);

	res.render(
		`entity/view/${entity.type.toLowerCase()}`,
		{title, identifierTypes}
	);
};

module.exports.displayDeleteEntity = (req, res) => {
	const entity = res.locals.entity;
	let title = entity.type;

	if (entity.defaultAlias && entity.defaultAlias.name) {
		title += ` “${entity.defaultAlias.name}”`;
	}

	res.render('entity/delete', {title});
};

module.exports.displayRevisions = (req, res, RevisionModel) => {
	const entity = res.locals.entity;
	let title = entity.type;

	if (entity.defaultAlias && entity.defaultAlias.name) {
		title += ` “${entity.defaultAlias.name}”`;
	}

	const bbid = req.params.bbid;
	return new RevisionModel()
		.where({bbid})
		.fetchAll({withRelated: ['revision', 'revision.author']})
		.then((collection) => {
			const revisions = collection.toJSON();
			return res.render('entity/revisions', {title, revisions});
		});
};

module.exports.handleDelete = (req, res, HeaderModel, RevisionModel) => {
	const entity = res.locals.entity;
	const editorJSON = req.session.passport.user;

	return bookshelf.transaction((transacting) => {
		const editorUpdatePromise = new Editor({id: editorJSON.id})
			.fetch({transacting})
			.then((editor) => {
				editor.set(
					'totalRevisions', editor.get('totalRevisions') + 1
				);
				editor.set(
					'revisionsApplied', editor.get('revisionsApplied') + 1
				);
				return editor.save(null, {transacting});
			});

		const newRevisionPromise = new Revision({
			authorId: editorJSON.id
		}).save(null, {transacting});

		const notePromise = req.body.note ? newRevisionPromise
			.then((revision) => new Note({
				authorId: editorJSON.id,
				revisionId: revision.get('id'),
				content: req.body.note
			}).save(null, {transacting})) : null;

		// No trigger for deletions, so manually create the <Entity>Revision
		// and update the entity header
		const newEntityRevisionPromise = newRevisionPromise
			.then((revision) => new RevisionModel({
				id: revision.get('id'),
				bbid: entity.bbid,
				dataId: null
			}).save(null, {method: 'insert', transacting}));

		const entityHeaderPromise = newEntityRevisionPromise
			.then((entityRevision) => new HeaderModel({
				bbid: entity.bbid,
				masterRevisionId: entityRevision.get('id')
			}).save(null, {transacting}));

		return Promise.join(
			editorUpdatePromise, newRevisionPromise, notePromise,
			newEntityRevisionPromise, entityHeaderPromise
		);
	})
		.then(() => {
			res.redirect(
				status.SEE_OTHER, `/${entity.type.toLowerCase()}/${entity.bbid}`
			);
		});
};

function setHasChanged(oldSet, newSet, compareFields) {
	const oldSetIds = _.map(oldSet, 'id');
	const newSetIds = _.map(newSet, 'id');

	const oldSetHash = {};
	oldSet.forEach((item) => { oldSetHash[item.id] = item; });

	// First, determine whether any items have been deleted, by excluding
	// all new IDs from the old IDs and checking whether any IDs remain
	const itemsHaveBeenDeletedOrAdded =
		_.difference(oldSetIds, newSetIds).length > 0 ||
		_.difference(oldSetIds, newSetIds).length > 0;

	if (itemsHaveBeenDeletedOrAdded) {
		return true;
	}

	// If not, return true if any items have changed (are not equal)
	return _.some(newSet, (newItem) => {
		const oldRepresentation = _.pick(oldSetHash[newItem.id], compareFields);
		const newRepresentation = _.pick(newItem, compareFields);
		return !_.isEqual(oldRepresentation, newRepresentation);
	});
}
module.exports.setHasChanged = setHasChanged;

function unchangedSetItems(oldSet, newSet, compareFields) {
	console.log(JSON.stringify(oldSet));
	console.log(JSON.stringify(newSet));
	return _.intersectionBy(newSet, oldSet, (item) => _.pick(item, compareFields));
}
module.exports.unchangedSetItems = unchangedSetItems;

function updatedOrNewSetItems(oldSet, newSet, compareFields) {
	console.log(JSON.stringify(oldSet));
	console.log(JSON.stringify(newSet));
	return _.differenceBy(
		newSet, oldSet, (item) => _.pick(item, compareFields)
	);
}
module.exports.updatedOrNewSetItems = updatedOrNewSetItems;

function processFormAliases(
	transacting, oldAliases, oldDefaultAliasId, newAliases
) {
	const aliasCompareFields =
		['name', 'sortName', 'languageId', 'primary', 'default'];
	const aliasesHaveChanged = setHasChanged(
		oldAliases, newAliases, aliasCompareFields
	);

	// If there is no change to the set of aliases, and the default alias is
	// the same, skip alias processing
	const newDefaultAlias = _.find(newAliases, 'default');
	if (!aliasesHaveChanged && newDefaultAlias.id === oldDefaultAliasId) {
		return null;
	}

	// Make a new alias set
	const newAliasSetPromise = new AliasSet().save(null, {transacting});
	const newAliasesPromise = newAliasSetPromise.then((newAliasSet) =>
		newAliasSet.related('aliases').fetch({transacting})
	);

	// Copy across any old aliases that are exactly the same in the new set
	const unchangedAliases =
		unchangedSetItems(oldAliases, newAliases, aliasCompareFields);
	const oldAliasesAttachedPromise = newAliasesPromise.then((collection) =>
		collection.attach(_.map(unchangedAliases, 'id'), {transacting})
	);

	// Create new aliases for any new or updated aliases, and attach them to
	// the set
	const newOrUpdatedAliases =
		updatedOrNewSetItems(oldAliases, newAliases, aliasCompareFields);
	const allAliasesAttachedPromise = oldAliasesAttachedPromise
		.then((collection) =>
			Promise.all(
				_.map(newOrUpdatedAliases, (alias) =>
					collection.create(_.omit(alias, 'id', 'default'), {transacting})
				)
			).then(() => collection)
		);

	// Set the default alias
	return Promise.join(newAliasSetPromise, allAliasesAttachedPromise,
		(newAliasSet, collection) => {
			const defaultAlias = collection.find((alias) =>
				alias.get('name') === newDefaultAlias.name &&
				alias.get('sortName') === newDefaultAlias.sortName &&
				alias.get('languageId') === newDefaultAlias.languageId
			);
			newAliasSet.set('defaultAliasId', defaultAlias.get('id'));
			return newAliasSet.save(null, {transacting});
		}
	);
}
module.exports.processFormAliases = processFormAliases;

function processFormIdentifiers(transacting, oldIdents, newIdents) {
	const identCompareFields =
		['value', 'typeId'];
	const identsHaveChanged = setHasChanged(
		oldIdents, newIdents, identCompareFields
	);

	// If there is no change to the set of identifiers
	if (!identsHaveChanged) {
		return null;
	}

	// Make a new identifier set
	const newIdentSetPromise = new IdentifierSet().save(null, {transacting});
	const newIdentsPromise = newIdentSetPromise.then((newIdentSet) =>
		newIdentSet.related('identifiers').fetch({transacting})
	);

	// Copy across any old aliases that are exactly the same in the new set
	const unchangedIdents =
		unchangedSetItems(oldIdents, newIdents, identCompareFields);
	console.log(`Unchanged: ${JSON.stringify(unchangedIdents)}`);
	const oldIdentsAttachedPromise = newIdentsPromise.then((collection) =>
		collection.attach(_.map(unchangedIdents, 'id'), {transacting})
	);

	// Create new aliases for any new or updated aliases, and attach them to
	// the set
	const newOrUpdatedIdents =
		updatedOrNewSetItems(oldIdents, newIdents, identCompareFields);
	console.log(`New: ${JSON.stringify(newOrUpdatedIdents)}`);
	const allIdentsAttachedPromise = oldIdentsAttachedPromise
		.then((collection) =>
			Promise.all(
				_.map(newOrUpdatedIdents, (ident) =>
					collection.create(_.omit(ident, 'id'), {transacting})
				)
			).then(() => collection)
		);

	return Promise.join(newIdentSetPromise, allIdentsAttachedPromise,
		(newIdentSet) => newIdentSet
	);
}
module.exports.processFormIdentifiers = processFormIdentifiers;

module.exports.createEntity = (
	req, res, EntityModel, derivedProps, onEntityCreation
) => {
	const editorJSON = req.session.passport.user;
	const entityCreationPromise = bookshelf.transaction((transacting) => {
		const editorUpdatePromise = new Editor({id: editorJSON.id})
			.fetch({transacting})
			.then((editor) => {
				editor.set(
					'totalRevisions', editor.get('totalRevisions') + 1
				);
				editor.set(
					'revisionsApplied', editor.get('revisionsApplied') + 1
				);
				return editor.save(null, {transacting});
			});

		const newRevisionPromise = new Revision({
			authorId: editorJSON.id
		}).save(null, {transacting});

		const notePromise = req.body.note ? newRevisionPromise
			.then((revision) => new Note({
				authorId: editorJSON.id,
				revisionId: revision.get('id'),
				content: req.body.note
			}).save(null, {transacting})) : null;

		const aliasSetPromise = processFormAliases(
			transacting, [], null, req.body.aliases || []
		);

		const identSetPromise = processFormIdentifiers(
			transacting, [], req.body.identifiers || []
		);

		const annotationPromise = req.body.annotation ? newRevisionPromise
			.then((revision) => new Annotation({
				content: req.body.annotation,
				lastRevisionId: revision.get('id')
			}).save(null, {transacting})) : null;

		const disambiguationPromise = req.body.disambiguation ?
			new Disambiguation({
				comment: req.body.disambiguation
			}).save(null, {transacting}) : null;

		return Promise.join(
			newRevisionPromise, aliasSetPromise, identSetPromise,
			annotationPromise, disambiguationPromise, editorUpdatePromise,
			notePromise,
			(newRevision, aliasSet, identSet, annotation, disambiguation) => {
				console.log(identSet);
				const propsToSet = _.extend({
					aliasSetId: aliasSet && aliasSet.get('id'),
					identifierSetId: identSet && identSet.get('id'),
					relationshipSetId: null,
					annotationId: annotation && annotation.get('id'),
					disambiguationId:
						disambiguation && disambiguation.get('id'),
					revisionId: newRevision.get('id')
				}, derivedProps);

				return new EntityModel(propsToSet)
					.save(null, {method: 'insert', transacting});
			})
			.then(
				(entityModel) =>
					onEntityCreation(req, transacting, entityModel)
						.then(() => entityModel.refresh({transacting}))
						.then((entity) => entity.toJSON())
			);
	});

	return entityCreationPromise.then((entity) =>
		res.send(entity)
	);
};
