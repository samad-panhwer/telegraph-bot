"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const client_1 = require("@prisma/client");
const node_cron_1 = __importDefault(require("node-cron"));
const dotenv_1 = require("dotenv");
const http_1 = __importDefault(require("http"));
(0, dotenv_1.config)();
http_1.default.createServer((req, res) => {
    res.writeHead(200);
    res.end('Telegraph Bot is Running!');
}).listen(process.env.PORT || 8080);
const prisma = new client_1.PrismaClient();
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMessages,
        discord_js_1.GatewayIntentBits.GuildMembers
    ]
});
const commands = [
    new discord_js_1.SlashCommandBuilder()
        .setName('in')
        .setDescription('Clock in for work')
        .addStringOption(opt => opt.setName('task').setDescription('What are you working on?').setRequired(true)),
    new discord_js_1.SlashCommandBuilder().setName('out').setDescription('Clock out from work'),
].map(command => command.toJSON());
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user?.tag}`);
    try {
        const rest = new discord_js_1.REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(discord_js_1.Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        console.log('✅ Slash Commands Registered');
    }
    catch (err) {
        console.error('❌ Failed to register commands:', err);
    }
    node_cron_1.default.schedule('59 23 * * *', async () => {
        try {
            const channel = client.channels.cache.get(process.env.SUMMARY_CHANNEL_ID);
            if (!channel)
                return;
            const sessions = await prisma.session.findMany({
                where: {
                    startTime: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
                    isActive: false
                },
                include: { user: true }
            });
            const embed = new discord_js_1.EmbedBuilder()
                .setTitle("📊 DAILY DEV SUMMARY")
                .setColor("#5865F2")
                .setTimestamp();
            const description = sessions.map(s => `**${s.user.username}**: ${s.task} \n⏱️ ${Math.floor((s.durationMins || 0) / 60)}h ${(s.durationMins || 0) % 60}m`).join('\n\n');
            embed.setDescription(description || "No work sessions completed today.");
            await channel.send({ embeds: [embed] });
        }
        catch (err) {
            console.error('❌ Cron Job Error:', err);
        }
    }, { timezone: "Asia/Karachi" });
});
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand())
        return;
    if (interaction.channelId !== process.env.DEV_CHANNEL_ID) {
        return interaction.reply({ content: "❌ Please use the designated dev channel for this command.", ephemeral: true });
    }
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const hasRole = member?.roles.cache.has(process.env.DEVELOPER_ROLE_ID);
    if (!hasRole) {
        return interaction.reply({ content: "❌ Only users with the Developer role can use this.", ephemeral: true });
    }
    const { commandName, user } = interaction;
    try {
        if (commandName === 'in') {
            const task = interaction.options.getString('task');
            const activeSession = await prisma.session.findFirst({
                where: { user: { discordId: user.id }, isActive: true }
            });
            if (activeSession) {
                return interaction.reply({ content: "❌ You are already clocked in! Use `/out` first.", ephemeral: true });
            }
            const dbUser = await prisma.user.upsert({
                where: { discordId: user.id },
                update: { username: user.username },
                create: { discordId: user.id, username: user.username }
            });
            await prisma.session.create({ data: { userId: dbUser.id, task } });
            await interaction.reply(`🚀 **${user.username}** is now working on: *${task}*`);
        }
        if (commandName === 'out') {
            const session = await prisma.session.findFirst({
                where: { user: { discordId: user.id }, isActive: true }
            });
            if (!session) {
                return interaction.reply({ content: "❌ You aren't clocked in!", ephemeral: true });
            }
            const duration = Math.round((new Date().getTime() - session.startTime.getTime()) / 60000);
            await prisma.session.update({
                where: { id: session.id },
                data: { isActive: false, endTime: new Date(), durationMins: duration }
            });
            const hours = Math.floor(duration / 60);
            const mins = duration % 60;
            await interaction.reply(`✅ **${user.username}** clocked out. \n**Duration:** ${hours}h ${mins}m`);
        }
    }
    catch (error) {
        console.error(error);
        await interaction.reply({ content: "⚠️ An error occurred while processing your request.", ephemeral: true });
    }
});
client.login(process.env.DISCORD_TOKEN);
//# sourceMappingURL=index.js.map