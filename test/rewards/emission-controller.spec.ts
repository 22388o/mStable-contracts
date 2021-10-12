/* eslint-disable no-await-in-loop */
/* eslint-disable no-plusplus */
import { DEAD_ADDRESS, ONE_WEEK } from "@utils/constants"
import { StandardAccounts } from "@utils/machines"
import { expect } from "chai"
import { ethers } from "hardhat"
import { increaseTime, simpleToExactAmount } from "index"
import {
    EmissionsController,
    EmissionsController__factory,
    MockERC20,
    MockERC20__factory,
    MockNexus,
    MockNexus__factory,
    MockRewardsDistributionRecipient,
    MockRewardsDistributionRecipient__factory,
    MockStakingContract,
    MockStakingContract__factory,
} from "types/generated"

describe("EmissionsController", async () => {
    let sa: StandardAccounts
    let nexus: MockNexus
    let staking1: MockStakingContract
    let staking2: MockStakingContract
    let rewardToken: MockERC20
    const dials: MockRewardsDistributionRecipient[] = []
    let emissionsController: EmissionsController
    const totalRewards = simpleToExactAmount(40000000)
    const weeklyRewards = totalRewards.div(312)

    const deployEmissionsController = async (): Promise<void> => {
        // staking contracts
        staking1 = await new MockStakingContract__factory(sa.default.signer).deploy()
        staking2 = await new MockStakingContract__factory(sa.default.signer).deploy()

        nexus = await new MockNexus__factory(sa.default.signer).deploy(sa.governor.address, DEAD_ADDRESS, DEAD_ADDRESS)
        rewardToken = await new MockERC20__factory(sa.default.signer).deploy(
            "Reward",
            "RWD",
            18,
            sa.default.address,
            simpleToExactAmount(100000000),
        )

        // Deploy dials
        for (let i = 0; i < 3; i++) {
            const newDial = await new MockRewardsDistributionRecipient__factory(sa.default.signer).deploy(rewardToken.address, DEAD_ADDRESS)
            dials.push(newDial)
        }

        emissionsController = await new EmissionsController__factory(sa.default.signer).deploy(
            nexus.address,
            [staking1.address, staking2.address],
            rewardToken.address,
            totalRewards,
        )
        const dialAddresses = dials.map((dial) => dial.address)
        await rewardToken.approve(emissionsController.address, totalRewards)
        await emissionsController.initialize(dialAddresses)
    }

    before(async () => {
        const accounts = await ethers.getSigners()
        sa = await new StandardAccounts().initAccounts(accounts)
    })

    describe("distribute rewards", () => {
        context("only one user has votes", () => {
            const user1Staking1Votes = simpleToExactAmount(100)
            const user1Staking2Votes = simpleToExactAmount(200)
            const user2Staking1Votes = simpleToExactAmount(600)
            const user1Votes = user1Staking1Votes.add(user1Staking2Votes)
            beforeEach(async () => {
                await deployEmissionsController()
                await staking1.setVotes(sa.dummy1.address, user1Staking1Votes)
                await staking2.setVotes(sa.dummy1.address, user1Staking2Votes)
                await staking1.setVotes(sa.dummy2.address, user2Staking1Votes)
                await increaseTime(ONE_WEEK)
            })
            it("all user 1 to dial 1", async () => {
                await emissionsController
                    .connect(sa.dummy1.signer)
                    .setVoterDialWeights([{ addr: dials[0].address, weight: simpleToExactAmount(1) }])
                expect((await emissionsController.dialData(dials[0].address)).weightedVotes).to.eq(user1Votes)
                const tx = await emissionsController.distributeRewards()
                await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, weeklyRewards)
            })
            it("all user 1 to dial 1, all user 2 to dial 2", async () => {
                await emissionsController
                    .connect(sa.dummy1.signer)
                    .setVoterDialWeights([{ addr: dials[0].address, weight: simpleToExactAmount(1) }])
                await emissionsController
                    .connect(sa.dummy2.signer)
                    .setVoterDialWeights([{ addr: dials[1].address, weight: simpleToExactAmount(1) }])
                expect((await emissionsController.dialData(dials[0].address)).weightedVotes).to.eq(user1Votes)
                const tx = await emissionsController.distributeRewards()
                await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[0].address, weeklyRewards.div(3))
                await expect(tx).to.emit(emissionsController, "DistributedReward").withArgs(dials[1].address, weeklyRewards.mul(2).div(3))
            })
        })
    })
})
