import "reflect-metadata";
import { expect } from "chai";
import { closeTestingConnections, createTestingConnections, reloadTestingDatabases } from "../../../utils/test-utils";
import { Connection, SelectQueryBuilder } from "../../../../src";
import { Logger } from "../../../../src/logger/Logger";
import { Author } from "./entity/Author";
import { Post } from "./entity/Post";
import { Tag } from "./entity/Tag";

/**
 * Records every statement the connection executes so tests can assert on the
 * SQL shape a query builder chose, not only on the rows it returned.
 */
class MemoryLogger implements Logger {
    queries: string[] = [];
    logQuery(query: string) { this.queries.push(query); }
    logQueryError() {}
    logQuerySlow() {}
    logSchemaBuild() {}
    logMigration() {}
    log() {}
    clear() { this.queries = []; }
}

const POST_COUNT = 7;

/**
 * `skip`/`take` over a query with joins historically always went through a
 * `SELECT DISTINCT ids FROM (<query>) "distinctAlias" ... LIMIT/OFFSET` subquery
 * plus an id re-fetch, and `getCount` through `COUNT(DISTINCT id)`. Both sort or
 * hash the whole filtered set on every page. Those shapes are only needed when a
 * join can multiply root rows; many-to-one / one-to-one joins keep one row per
 * root row and are paginated directly. These tests pin which shape is chosen
 * for each kind of join, and that the direct shape returns the same pages.
 */
describe("query builder > pagination", () => {

    let connections: Connection[];
    before(async () => connections = await createTestingConnections({
        entities: [Author, Post, Tag],
        enabledDrivers: ["sqlite", "better-sqlite3", "postgres"],
        createLogger: () => new MemoryLogger(),
    }));
    beforeEach(() => reloadTestingDatabases(connections));
    after(() => closeTestingConnections(connections));

    const logger = (connection: Connection) => connection.logger as MemoryLogger;

    /** Seeds 3 authors, 2 tags and POST_COUNT posts; every post has an author, even ones have both tags. */
    async function seed(connection: Connection) {
        const authors = await connection.manager.save(
            ["Ada", "Bob", "Cyd"].map(name => Object.assign(new Author(), { name }))
        );
        const tags = await connection.manager.save(
            ["news", "tips"].map(name => Object.assign(new Tag(), { name }))
        );
        const posts: Post[] = [];
        for (let i = 1; i <= POST_COUNT; i++) {
            posts.push(Object.assign(new Post(), {
                title: `post ${i}`,
                author: authors[i % authors.length],
                tags: i % 2 === 0 ? tags : [],
            }));
        }
        await connection.manager.save(posts);
    }

    it("paginates a many-to-one join with plain LIMIT/OFFSET", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        const [posts, count] = await connection.manager.createQueryBuilder(Post, "post")
            .leftJoinAndSelect("post.author", "author")
            .orderBy("post.title", "ASC")
            .skip(2)
            .take(3)
            .getManyAndCount();

        expect(posts.map(post => post.title)).to.deep.equal(["post 3", "post 4", "post 5"]);
        expect(posts.every(post => post.author instanceof Author)).to.be.true;
        expect(count).to.equal(POST_COUNT);

        const [pageQuery, countQuery, ...rest] = logger(connection).queries;
        expect(rest).to.be.empty;
        expect(pageQuery).to.not.contain("distinctAlias");
        expect(pageQuery).to.contain("LIMIT 3 OFFSET 2");
        expect(countQuery).to.contain("COUNT(1)");
        expect(countQuery).to.not.contain("DISTINCT");
    })));

    it("appends the primary key to the order so direct pages are stable", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        // Every post shares the same author name, so without a tiebreaker the page
        // boundaries would be decided by the database's whim.
        await connection.manager.createQueryBuilder(Post, "post")
            .leftJoinAndSelect("post.author", "author")
            .orderBy("author.name", "ASC")
            .take(2)
            .getMany();

        const [pageQuery] = logger(connection).queries;
        expect(pageQuery).to.match(/ORDER BY "author"."name" ASC, "post"."id" ASC/);
    })));

    it("does not duplicate a primary key the caller already orders by", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        await connection.manager.createQueryBuilder(Post, "post")
            .leftJoinAndSelect("post.author", "author")
            .orderBy("post.id", "DESC")
            .take(2)
            .getMany();

        const [pageQuery] = logger(connection).queries;
        expect(pageQuery).to.match(/ORDER BY "post"."id" DESC(?! *,)/);
    })));

    it("keeps the DISTINCT path for a one-to-many join", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        const [authors, count] = await connection.manager.createQueryBuilder(Author, "author")
            .leftJoinAndSelect("author.posts", "post")
            .orderBy("author.name", "ASC")
            .take(2)
            .getManyAndCount();

        // A naive LIMIT 2 over the joined rows would have returned a single author.
        expect(authors.map(author => author.name)).to.deep.equal(["Ada", "Bob"]);
        expect(authors.every(author => author.posts.length >= 2)).to.be.true;
        expect(count).to.equal(3);

        const queries = logger(connection).queries;
        expect(queries[0]).to.contain("distinctAlias");
        expect(queries[queries.length - 1]).to.contain("COUNT(DISTINCT");
    })));

    it("keeps the DISTINCT path for a many-to-many join", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        const [posts, count] = await connection.manager.createQueryBuilder(Post, "post")
            .leftJoinAndSelect("post.tags", "tag")
            .orderBy("post.title", "ASC")
            .take(2)
            .getManyAndCount();

        expect(posts.map(post => post.title)).to.deep.equal(["post 1", "post 2"]);
        expect(posts[1].tags).to.have.length(2);
        expect(count).to.equal(POST_COUNT);

        const queries = logger(connection).queries;
        expect(queries[0]).to.contain("distinctAlias");
        expect(queries[queries.length - 1]).to.contain("COUNT(DISTINCT");
    })));

    it("keeps the DISTINCT path for a raw table join of unknown cardinality", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        const [posts, count] = await connection.manager.createQueryBuilder(Post, "post")
            .leftJoin("author", "a", "a.id = post.authorId")
            .orderBy("post.title", "ASC")
            .take(2)
            .getManyAndCount();

        expect(posts).to.have.length(2);
        expect(count).to.equal(POST_COUNT);

        const queries = logger(connection).queries;
        expect(queries[0]).to.contain("distinctAlias");
        expect(queries[queries.length - 1]).to.contain("COUNT(DISTINCT");
    })));

    it("walks direct pages in the same order as the unpaginated result, without gaps or repeats", () => Promise.all(connections.map(async connection => {
        await seed(connection);

        // Order by a joined column with ties, then by title: exactly the shape where a
        // LIMIT/OFFSET walk would drift if the tiebreaker or the offsets were wrong.
        const query = () => connection.manager.createQueryBuilder(Post, "post")
            .leftJoinAndSelect("post.author", "author")
            .orderBy("author.name", "DESC")
            .addOrderBy("post.title", "ASC");

        const expected = (await query().getMany()).map(post => post.id);

        const pages: number[][] = [];
        const totals: number[] = [];
        for (let skip = 0; skip < POST_COUNT + 2; skip += 2) {
            const [posts, count] = await query().skip(skip).take(2).getManyAndCount();
            pages.push(posts.map(post => post.id));
            totals.push(count);
        }

        expect(([] as number[]).concat(...pages)).to.deep.equal(expected);
        expect(pages.map(page => page.length)).to.deep.equal([2, 2, 2, 1, 0]);
        expect(totals.every(total => total === POST_COUNT)).to.be.true;
    })));

    it("skips the count query when the page proves the total", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        const qb = () => connection.manager.createQueryBuilder(Post, "post")
            .leftJoinAndSelect("post.author", "author")
            .orderBy("post.title", "ASC");

        // Short first page: everything fits, no count needed.
        logger(connection).clear();
        let [posts, count] = await qb().take(10).getManyAndCount();
        expect(posts).to.have.length(POST_COUNT);
        expect(count).to.equal(POST_COUNT);
        expect(logger(connection).queries).to.have.length(1);

        // Short page behind an offset: the total includes the skipped rows.
        logger(connection).clear();
        [posts, count] = await qb().skip(5).take(3).getManyAndCount();
        expect(posts).to.have.length(2);
        expect(count).to.equal(POST_COUNT);
        expect(logger(connection).queries).to.have.length(1);

        // Exactly full page: the count has to run.
        logger(connection).clear();
        [posts, count] = await qb().take(POST_COUNT).getManyAndCount();
        expect(posts).to.have.length(POST_COUNT);
        expect(count).to.equal(POST_COUNT);
        expect(logger(connection).queries).to.have.length(2);

        // Empty page past the end: says nothing about where the end is, count has to run.
        logger(connection).clear();
        [posts, count] = await qb().skip(20).take(3).getManyAndCount();
        expect(posts).to.have.length(0);
        expect(count).to.equal(POST_COUNT);
        expect(logger(connection).queries).to.have.length(2);

        // The shortcut also applies to the DISTINCT path: a short page of distinct roots is just as conclusive.
        logger(connection).clear();
        const [authors, authorCount] = await connection.manager.createQueryBuilder(Author, "author")
            .leftJoinAndSelect("author.posts", "post")
            .take(10)
            .getManyAndCount();
        expect(authors).to.have.length(3);
        expect(authorCount).to.equal(3);
        expect(logger(connection).queries.some(query => query.includes("COUNT("))).to.be.false;
    })));

    it("does not infer the total from a partial selection that omits the primary key", () => Promise.all(connections.map(async connection => {
        await seed(connection);

        // Without the primary key in the selection every raw row is grouped under the
        // same empty key, so the page hydrates into a single entity. Nothing about the
        // total can be read off that, with or without a join.
        for (const withJoin of [false, true]) {
            logger(connection).clear();

            let qb = connection.manager.createQueryBuilder(Post, "post")
                .select("post.title")
                .orderBy("post.title", "ASC")
                .take(3);
            if (withJoin)
                qb = qb.leftJoin("post.author", "author");

            const [posts, count] = await qb.getManyAndCount();

            expect(posts.length).to.be.at.most(3);
            expect(count).to.equal(POST_COUNT);
            expect(logger(connection).queries).to.have.length(2);
        }
    })));

    it("leaves explicit limit/offset alone when inferring the total", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        // `limit` wins over `take` in the SQL, so a short page here says nothing about the total.
        const [posts, count] = await connection.manager.createQueryBuilder(Post, "post")
            .leftJoinAndSelect("post.author", "author")
            .orderBy("post.title", "ASC")
            .limit(2)
            .take(10)
            .getManyAndCount();

        expect(posts).to.have.length(2);
        expect(count).to.equal(POST_COUNT);
        expect(logger(connection).queries).to.have.length(2);
    })));

    it("keeps the DISTINCT path for shapes it does not reason about, even with only many-to-one joins", () => Promise.all(connections.map(async connection => {
        await seed(connection);

        const expectDistinctShape = () => {
            const queries = logger(connection).queries;
            expect(queries[0]).to.contain("distinctAlias");
            expect(queries[queries.length - 1]).to.contain("COUNT(DISTINCT");
        };

        // A second FROM source is a cross product: 2 tags x 7 posts = 14 rows. The
        // join hangs off the last FROM item because Postgres binds a JOIN only to the
        // FROM entry right before it. `addFrom` retypes the builder to the added
        // entity, but rows still hydrate into tags, the main alias.
        logger(connection).clear();
        const [tags, tagCount] = await (connection.manager.createQueryBuilder(Tag, "tag")
            .addFrom(Post, "post")
            .leftJoin("post.author", "author") as unknown as SelectQueryBuilder<Tag>)
            .orderBy("tag.name", "ASC")
            .take(1)
            .getManyAndCount();

        expect(tags.map(tag => tag.name)).to.deep.equal(["news"]);
        expect(tagCount).to.equal(2);
        expectDistinctShape();

        // SELECT DISTINCT, where an appended primary-key ORDER BY is not always valid.
        logger(connection).clear();
        const [posts, postCount] = await connection.manager.createQueryBuilder(Post, "post")
            .distinct(true)
            .leftJoinAndSelect("post.author", "author")
            .orderBy("post.title", "ASC")
            .take(3)
            .getManyAndCount();

        expect(posts.map(post => post.title)).to.deep.equal(["post 1", "post 2", "post 3"]);
        expect(postCount).to.equal(POST_COUNT);
        expectDistinctShape();
    })));

    it("does not infer the total when several FROM sources multiply rows", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        // No joins, so this is upstream's direct path: LIMIT applies to the 14 raw
        // rows of the cross product, which hydrate into 7 posts. Seven is below
        // `take`, but it is not the count upstream reports, so the count must run.
        const [posts, count] = await connection.manager.createQueryBuilder(Post, "post")
            .addFrom(Tag, "tag")
            .take(20)
            .getManyAndCount();

        expect(posts).to.have.length(POST_COUNT);
        expect(count).to.equal(POST_COUNT * 2);
        expect(logger(connection).queries).to.have.length(2);
    })));

    it("still paginates a query without joins directly", () => Promise.all(connections.map(async connection => {
        await seed(connection);
        logger(connection).clear();

        const [posts, count] = await connection.manager.createQueryBuilder(Post, "post")
            .orderBy("post.title", "ASC")
            .take(POST_COUNT)
            .getManyAndCount();

        expect(posts).to.have.length(POST_COUNT);
        expect(count).to.equal(POST_COUNT);

        const [pageQuery, countQuery] = logger(connection).queries;
        expect(pageQuery).to.not.contain("distinctAlias");
        expect(pageQuery).to.contain(`LIMIT ${POST_COUNT}`);
        expect(countQuery).to.contain("COUNT(1)");
    })));

});
