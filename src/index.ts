import bodyParser from 'body-parser';
import express, { query } from 'express';
import { Router } from 'express';
import { Chalk } from 'chalk';
import Letta from "@letta-ai/letta-client";
import { ServerResponse } from 'http';
import { Writable } from "node:stream";
require('dotenv').config();
const client = new Letta();

interface PluginInfo {
    id: string;
    name: string;
    description: string;
}

interface Plugin {
    init: (router: Router) => Promise<void>;
    exit: () => Promise<void>;
    info: PluginInfo;
}

const chalk = new Chalk();
const MODULE_NAME = '[Letta]';
const PORT = 5001;
const LINK_ID_PREFIX = 'ST_LINK_ID:'

/**
 * Initialize the plugin.
 * @param router Express Router
 */
export async function init(router: Router): Promise<void> {
    const jsonParser = bodyParser.json();
    // Used to check if the server plugin is running
    router.post('/probe', (_req, res) => {
        return res.sendStatus(204);
    });
    // Use body-parser to parse the request body
    router.post('/ping', jsonParser, async (req, res) => {
        try {
            const { message } = req.body;
            return res.json({ message: `Pong! ${message}` });
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    // START Letta Glue
    router.post('/update_character', jsonParser, async (req, res) => {
        try {
            console.log('--- Update Letta Agent ---');
            console.log(JSON.stringify(req.body, null, 2));

            const { agent_id, characterId, character_json, agent_settings, model_settings} = req.body;
            const character = JSON.parse(character_json);
            const link_id = LINK_ID_PREFIX + characterId;
            
            let agent_id_loaded = null;
            let doUpdate = false;
            if(agent_id){
                try{
                    console.log('Attempting agent fetch from ID.');
                    agent_id_loaded = (await client.agents.retrieve(agent_id)).id;
                    doUpdate = true;
                    console.log('Agent fetched from ID.');
                } catch (error){
                    console.log('Failed to fetch agent from ID.');
                }
            }

            if(!agent_id_loaded){
                console.log('Listing existing agents by tag.');
                if(!characterId) throw "Character ID not provided.";
                const matching_agents = (await client.agents.list({tags: [link_id]})).items;
                // create missing
                if(matching_agents.length==0){
                    const [agent_create, description_blk, personality_blk, scenario_blk] = await Promise.all([
                        client.agents.create({
                            name: character.name,
                            description: character.creatorcomment,
                            tags: [link_id, ...character.tags],
                            model_settings: model_settings,
                            ...agent_settings,
                        }),
                        client.blocks.create({label: 'character_description', value: character.description, read_only: true}),
                        client.blocks.create({label: 'character_personality', value: character.personality, read_only: true}),
                        client.blocks.create({label: 'character_scenario', value: character.scenario, read_only: true}),
                    ]);

                    agent_id_loaded = agent_create.id;
                    await Promise.all([
                        client.agents.blocks.attach(description_blk.id, {agent_id: agent_id_loaded}),
                        client.agents.blocks.attach(personality_blk.id, {agent_id: agent_id_loaded}),
                        client.agents.blocks.attach(scenario_blk.id, {agent_id: agent_id_loaded}),
                    ]);
                    
                    console.log('Agent created.');
                }else{
                    agent_id_loaded = matching_agents[0].id
                    doUpdate = true;
                    console.log('Agent found by tag.');
                }
            }

            if(!agent_id_loaded){
                throw 'Agent could not be retrieved or created.';
            }

            if(doUpdate){
                // update existing
                const {
                    embedding, // Prevent this from being changed
                    ...rest_settings
                } = agent_settings;

                await Promise.all([
                    client.agents.update(agent_id_loaded, {
                        name: character.name,
                        description: character.creatorcomment,
                        tags: [link_id, ...character.tags],
                        model_settings: model_settings,
                        ...rest_settings,
                    }),
                    client.agents.blocks.update('character_description', {agent_id: agent_id_loaded, value: character.description}),
                    client.agents.blocks.update('character_personality', {agent_id: agent_id_loaded, value: character.personality}),
                    client.agents.blocks.update('character_scenario', {agent_id: agent_id_loaded, value: character.scenario}),
                ]);
                console.log('Agent updated.');
            }
            
            return res.status(200).json({agent_id: agent_id_loaded});
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });         

    var load_stash: any = {};
    router.post('/load_chat', jsonParser, async (req, res) => {
        try {
            console.log('--- Load Letta Conversation ---');
            // console.log(JSON.stringify(req.body, null, 2));
            
            load_stash = req.body;

            // Check if this chat is created
            if(!load_stash.conversation_id) {
                const conversation = await client.conversations.create({agent_id: load_stash.agent_id, summary: load_stash.title});
                load_stash.conversation_id = conversation.id;
                load_stash.n_messages = null; // send all to newly created conversation
            }

            return res.status(200).json({conversation_id: load_stash.conversation_id});
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });
    
    router.post('/get_character', jsonParser, async (req, res) => {
        try {
            console.log('--- Get Letta Agent ---');
            // console.log(JSON.stringify(req.body, null, 2));

            const { characterId } = req.body;
            const link_id = LINK_ID_PREFIX + characterId;

            const matching_agents = (await client.agents.list({tags: [link_id]})).items;
            if(matching_agents.length==0){
                console.log('Agent not found for tag:', link_id);
            }else{
                const agent = matching_agents[0];
                console.log('Agent found by tag.');
                return res.status(200).json({agent_id: agent.id});
            }
            return res.status(500);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    router.post('/get_chat', jsonParser, async (req, res) => {
        try {
            console.log('--- Get Letta Conversation ---');
            console.log(JSON.stringify(req.body, null, 2));

            const { title, agent_id } = req.body;

            const matching_conversations = (await client.conversations.list({agent_id: agent_id, summary_search: title}));
            if(matching_conversations.length==0){
                console.log('Conversation not found for title: ', title);
            }else{
                const converastion = matching_conversations[0];
                console.log('Conversation found by title.');
                return res.status(200).json({conversation_id: converastion.id});
            }
            return res.status(500);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    function buildPrompt(prompts: Array<any>, prompt_order: Array<any>) {
        return prompt_order
            .filter(o => o.enabled)
            .map(o => prompts.find(p => p.identifier === o.identifier))
            .filter(Boolean)
            .map(p => p.content)
            .filter(c => c?.trim()) // drop empty white space
            .join('\n');
    }

    router.post('/update_prompt', jsonParser, async (req, res) => {
        try{
            console.log('--- Update Letta Prompt ---');
            // console.log(JSON.stringify(req.body, null, 2));

            const { agent_id, prompts, prompt_order } = req.body;

            const system_prompt = buildPrompt(prompts, prompt_order[0].order); // using first order group

            await client.agents.update(agent_id, {
                system: system_prompt
            });

            console.log('System prompt set:\n' + system_prompt);
            return res.status(200).send();
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    router.post('/edit', jsonParser, async (req, res) => {
        try{
            console.log('--- Edit Letta Messages ---');
            // console.log(JSON.stringify(req.body, null, 2));

            const { agent_id, conversation_id, n_messages } = req.body;
            try{
                // await client.conversations.delete(conversation_id);
                fetch(`${client.baseURL}/v1/conversations/${load_stash.conversation_id}`, {
                    method: "DELETE",
                    headers: {
                        "Content-Type": "application/json",
                        ...(client.apiKey && { Authorization: `Bearer ${client.apiKey}` }),
                    }
                });
                console.log(`Conversation Deleted: ${conversation_id}`);
            }catch (error) {
                console.log(`Failed to Delete Conversation: ${conversation_id}\n ${error}`);
            }

            const conversation = await client.conversations.create({agent_id: agent_id, summary: load_stash.title});

            load_stash.n_messages = n_messages ?? null; // send all if null
            load_stash.conversation_id = conversation.id;
            load_stash.agent_id = agent_id.id;
            
            return res.status(200).json({conversation_id: load_stash.conversation_id});
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    // Handle deletions
    router.post('/delete_character', jsonParser, async (req, res) => {
        try {
            console.log('--- Delete Letta Agent ---');

            const { agent_id } = req.body;
            
            await fetch(`${client.baseURL}/v1/agents/${load_stash.agent_id}`, {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                    ...(client.apiKey && { Authorization: `Bearer ${client.apiKey}` }),
                }
            });
        
            console.log(`Agent Deleted: ${agent_id}`);
            return res.status(200);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    router.post('/delete_chat', jsonParser, async (req, res) => {
        try {
            console.log('--- Delete Letta Conversation ---');

            const { conversation_id } = req.body;
            if(!conversation_id) throw "ID not provided.";

            await fetch(`${client.baseURL}/v1/conversations/${load_stash.conversation_id}`, {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                    ...(client.apiKey && { Authorization: `Bearer ${client.apiKey}` }),
                }
            });
        
            console.log(`Conversation Deleted: ${conversation_id}`);
            return res.status(200);
        } catch (error) {
            console.error(chalk.red(MODULE_NAME), 'Request failed', error);
            return res.status(500).send('Internal Server Error');
        }
    });

    function lettaChunkToOpenAI(chunk: string, buffer: string, callback: Function){
        // console.log('Chunk: ', chunk);
        buffer += chunk.replace(/\r\n/g, "\n");
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            let raw = line.trim();
            if(raw.startsWith("data: ")) raw = raw.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;

            let letta: any;
            try { letta = JSON.parse(raw); } catch {
                // console.log('!!!Invalid JSON!!!');
                continue;
            }

            switch(letta.message_type){
                case "assistant_message":
                    // {"id":"message-7e0f738b-d138-40d6-bac7-4347751d573a","date":"2026-05-25T04:19:30+00:00","name":null,"message_type":"assistant_message","otid":"7e0f738b-d138-40d6-bac7-4347751d5700","sender_id":null,"step_id":"step-f00a9788-aa54-498d-b664-e253b5b7dcd9","is_err":null,"seq_id":null,"run_id":"run-76568f61-da60-42a9-855c-3aa80d16ca13","content":" and"}
                    if(!letta.content) continue;
                    const openai_chunk = {
                        id: letta.run_id ?? "letta",
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.parse(letta.date) / 1000),
                        choices: [{
                            index: 0,
                            delta: { content: letta.content },
                            finish_reason: null,
                        }],
                    };

                    callback(openai_chunk);
                    break;

                case "tool_call_message":
                    // {"id":"message-02bb6cf9-fd51-4c09-85c2-59848efd8c13","date":"2026-05-25T04:19:23+00:00","name":null,"message_type":"tool_call_message","otid":"02bb6cf9-fd51-4c09-85c2-59848efd8c01","sender_id":null,"step_id":"step-3a228a21-6565-4a5b-8ccc-7b64984200f4","is_err":null,"seq_id":null,"run_id":"run-76568f61-da60-42a9-855c-3aa80d16ca13","tool_call":{"tool_call_id":"019e5d5be6e324e71a70b794083713fb"},"tool_calls":{"tool_call_id":"019e5d5be6e324e71a70b794083713fb"}}
                    const tool_call = letta.tool_call ?? letta.tool_calls;

                    const openaiChunk = {
                        id: letta.run_id ?? "letta",
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.parse(letta.date) / 1000),
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "",//tool_call.tool_call_id,
                                            type: "function",
                                            function: {
                                                name: letta.name ?? "",
                                                arguments: tool_call.arguments ?? "",
                                            },
                                        },
                                    ],
                                },
                                finish_reason: null,
                            },
                        ],
                    };

                    callback(openaiChunk);
                    break;    

                case "tool_return_message":
                // {"id":"message-3b03e636-e42b-4225-90a0-237b7989d5d6","date":"2026-05-25T04:19:26+00:00","name":"memory_insert","message_type":"tool_return_message","otid":"3b03e636-e42b-4225-90a0-237b7989d580","sender_id":null,"step_id":"step-3a228a21-6565-4a5b-8ccc-7b64984200f4","is_err":null,"seq_id":null,"run_id":"run-76568f61-da60-42a9-855c-3aa80d16ca13","tool_return":"Error This block is read-only and cannot be edited.","status":"error","tool_call_id":"019e5d5be6e324e71a70b794083713fb","stdout":null,"stderr":["Error executing function memory_insert: ValueError: Error This block is read-only and cannot be edited."],"tool_returns":[{"type":"tool","tool_return":"Error This block is read-only and cannot be edited.","status":"error","tool_call_id":"019e5d5be6e324e71a70b794083713fb","stdout":null,"stderr":["Error executing function memory_insert: ValueError: Error This block is read-only and cannot be edited."]}]}
                case "stop_reason":
                    // console.log('Stop: ', letta.stop_reason);
                case "usage_statistics":
                    // console.log('Stats: ', letta);
                default:
                    break;
            }
        }
    }

    // Separate Express server for OpenAI-compatible routes
    const app = express();
    app.post("/v1/chat/completions", jsonParser, async (req, res) => {
        try {
            console.log('--- Letta Passthrough ---');
            console.log(JSON.stringify(load_stash, null, 2));
            console.log(JSON.stringify(req.body, null, 2));
            
            let messages = req.body.messages; // use all messages
            if(load_stash.n_messages){ // restrict messages to recent
                messages = messages
                    .slice(-load_stash.n_messages)
                    .filter((m: any)=> m.role !== "system"); // Remove sys messages when syncing.
            }
            load_stash.n_messages = 1; // Default to sending last message (mostly to prevent locking into edit state)

            console.log('Sending:\n', JSON.stringify(messages));
            console.log('\n\nTo:\n', load_stash.conversation_id);

            const response = await fetch(`${client.baseURL}/v1/conversations/${load_stash.conversation_id}/messages`, {
                method: "POST",    
                headers: {
                    "Content-Type": "application/json",
                    Accept: "text/event-stream",
                    ...(client.apiKey && { Authorization: `Bearer ${client.apiKey}` }),
                },
                body: JSON.stringify({
                    ...req.body,
                    model: load_stash.agent_id,
                    messages: messages,
                    streaming: load_stash.streaming ?? req.body.streaming,
                    stream_tokens: load_stash.stream_tokens ?? true,
                    background: load_stash.background ?? false,
                })
            });

            if (!response.ok || !response.body) {
                const err = await response.text();
                return res.status(response.status).json({ error: err });
            }
            var stream = response.body;

            // const response = await client.conversations.messages.create(load_stash.conversation_id, {
            //     messages: messages,
            //     streaming: load_stash.streaming ?? req.body.streaming,
            //     stream_tokens: load_stash.stream_tokens ?? false,
            //     background: load_stash.background ?? false,
            // });
            // var stream = response.toReadableStream();

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");

            const reader = stream.getReader();
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();

            try {
                var buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    lettaChunkToOpenAI(chunk, buffer, (openai_chunk: Object)=>{
                        const openai_data = encoder.encode(`data: ${JSON.stringify(openai_chunk)}\n\n`);
                        // console.log('Data:\n', openai_data);
                        res.write(openai_data);
                        if (typeof (res as any).flush === "function") (res as any).flush(); // force flush to prevent buffering the response.
                    });
                }
            } finally {
                res.end();
            }
        } catch (error) {
            // Avoid writing headers twice if streaming already started
            if (!res.headersSent) {
                res.status(500).json({ error: "Internal Server Error" });
            } else {
                res.end();
            }
            console.error(chalk.red(MODULE_NAME), "Request failed", error);
        }
    });

    app.get("/health", (_req, res) => {
        res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    // Get models once
    const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
    const OPENROUTER_MODELS = await fetchFromOpenRouter("/models", process.env.OPENROUTER_API_KEY!);

    async function fetchFromOpenRouter(path: string, apiKey: string) {
    const res = await fetch(`${OPENROUTER_BASE}${path}`, {
        headers: {
        Authorization: `Bearer ${apiKey}`,
        },
    });
    if (!res.ok) throw Object.assign(new Error("OpenRouter error"), { status: res.status });
        return res.json();
    }

    app.get("/v1/models", async (req, res) => {
        try {
            // Connect
            // console.log('Headers:\n', JSON.stringify(req.headers));
            const authKey = req.headers['authorization']?.split(' ')[1];
            client.apiKey = String(authKey);
            client.baseURL = String(req.headers['letta_base_url'] ?? 'https://api.letta.com');            

            // console.log('Key:', client.apiKey);
            // console.log('URL:', client.baseURL);

            res.json(OPENROUTER_MODELS);
        } catch (err: any) {
            res.status(err.status ?? 502).json({ error: { message: err.message, type: "proxy_error" } });
        }
    });

    app.listen(PORT, () => {
        console.log(`Letta OpenAI-compatible server running on http://localhost:${PORT}`);
    });

    console.log(chalk.green(MODULE_NAME), 'Plugin loaded!');
}

export async function exit(): Promise<void> {
    console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}

export const info: PluginInfo = {
    id: 'letta-plugin',
    name: 'Letta Plugin',
    description: 'Letta memory management as backend.',
};

const plugin: Plugin = {
    init,
    exit,
    info,
};

export default plugin;
